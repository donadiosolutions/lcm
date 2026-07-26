import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  NATIVE_TRANSCRIPT_MAX_JSON_DEPTH,
  type JsonObject,
  type JsonValue,
  type NativeTranscriptBatchInput,
  type NativeTranscriptCheckpointRecord,
} from "../../src/storage/contracts.js";
import type { PostgreSqlQueryOptions } from "../../src/storage/postgresql/contracts.js";
import {
  PostgreSqlNativeTranscriptConflictError,
  PostgreSqlNativeTranscriptDataError,
  type PostgreSqlNativeTranscriptExecutor,
  type PostgreSqlNativeTranscriptScopedExecutor,
  PostgreSqlNativeTranscriptRepository,
} from "../../src/storage/postgresql/native-transcript-repository.js";
import { PostgreSqlCommitOutcomeUnknownError } from "../../src/storage/postgresql/errors.js";

const projectId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";
const machineId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9021";
const transcriptId = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9022";
const contentSha256 = "a".repeat(64);
const ingestKey = "b".repeat(64);

function nestedContainer(
  depth: number,
  kind: "array" | "object",
): JsonObject | JsonValue[] {
  let value: JsonValue = "leaf";
  for (let index = 0; index < depth; index += 1) {
    value = kind === "array" ? [value] : { nested: value };
  }
  return value as JsonObject | JsonValue[];
}

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

const linkRow = {
  transcript_id: transcriptId,
  conversation_id: "41",
  message_id: 51n,
  source_ordinal: "0",
};

const transcriptRow = {
  transcript_id: transcriptId,
  project_id: projectId,
  machine_id: machineId,
  client_name: "codex",
  format_name: "codex-jsonl",
  format_version: "v1",
  native_session_id: "session-a",
  source_locator: "sessions/a.jsonl",
  source_ordinal: "3",
  observed_at: "2026-01-01T00:00:00.000Z",
  ingested_at: new Date("2026-01-01T00:00:01.000Z"),
  scrubber_version: "scrubber-v1",
  content_sha256: contentSha256,
  ingest_key: ingestKey,
  native_payload: { type: "message", text: "hello", nested: [true, 1, null] },
  message_links: [linkRow],
};

const checkpointRow = {
  project_id: projectId,
  machine_id: machineId,
  client_name: "codex",
  source_locator: "sessions/a.jsonl",
  last_source_ordinal: "3",
  imported_count: "1",
  skipped_count: 0n,
  quarantined_count: 2,
  checkpoint: { byteOffset: 42, prefixSha256: "c".repeat(64) },
  updated_at: "2026-01-01T00:00:02.000Z",
};

const initialCheckpointRow = {
  ...checkpointRow,
  last_source_ordinal: "0",
  imported_count: "0",
  skipped_count: "0",
  quarantined_count: "0",
  checkpoint: {},
  updated_at: "2026-01-01T00:00:00.000Z",
};

const checkpointRecord: NativeTranscriptCheckpointRecord = {
  projectId,
  machineId,
  clientName: "codex",
  sourceLocator: "sessions/a.jsonl",
  lastSourceOrdinal: 3,
  importedCount: 1,
  skippedCount: 0,
  quarantinedCount: 2,
  checkpoint: { prefixSha256: "c".repeat(64), byteOffset: 42 },
  updatedAt: new Date("2026-01-01T00:00:02.000Z"),
};

const batch: NativeTranscriptBatchInput = {
  machineId,
  clientName: "codex",
  sourceLocator: "sessions/a.jsonl",
  expectedCheckpoint: null,
  records: [{
    formatName: "codex-jsonl",
    formatVersion: "v1",
    nativeSessionId: "session-a",
    sourceOrdinal: 3,
    observedAt: new Date("2026-01-01T00:00:00.000Z"),
    scrubberVersion: "scrubber-v1",
    contentSha256,
    ingestKey,
    nativePayload: {
      type: "message",
      text: "hello",
      nested: [true, 1, null],
    },
    messageLinks: [{
      conversationId: 41,
      messageId: 51,
      sourceOrdinal: 0,
    }],
  }],
  checkpoint: {
    lastSourceOrdinal: 3,
    checkpoint: { byteOffset: 42, prefixSha256: "c".repeat(64) },
  },
  quarantinedCount: 2,
};

function executor(
  implementation: (
    config: QueryConfig<unknown[]>,
    options: PostgreSqlQueryOptions,
  ) => QueryResult<QueryResultRow> | Promise<QueryResult<QueryResultRow>>,
  afterTransaction?: () => never,
): PostgreSqlNativeTranscriptExecutor & {
  query: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(implementation);
  const db = {
    query,
    transaction: vi.fn(async (
      callback: Parameters<PostgreSqlNativeTranscriptExecutor["transaction"]>[0],
    ) => {
      const value = await callback(db);
      afterTransaction?.();
      return value;
    }),
  } as unknown as PostgreSqlNativeTranscriptExecutor & {
    query: ReturnType<typeof vi.fn>;
    transaction: ReturnType<typeof vi.fn>;
  };
  return db;
}

function successfulQuery(
  config: QueryConfig<unknown[]>,
): QueryResult<QueryResultRow> {
  if (config.text === "SET TRANSACTION ISOLATION LEVEL READ COMMITTED") {
    return result([]);
  }
  if (config.text.includes("transaction_isolation")) {
    return result([{ transaction_isolation: "read committed" }]);
  }
  if (config.text.includes("INSERT INTO lcm.ingest_checkpoints")) {
    return result([initialCheckpointRow]);
  }
  if (config.text.includes("FOR UPDATE")) {
    return result([checkpointRow]);
  }
  if (config.text.includes("INSERT INTO lcm.native_transcripts")) {
    return result([{ ...transcriptRow, message_links: [] }]);
  }
  if (config.text.includes("INSERT INTO lcm.transcript_messages")) {
    return result([linkRow]);
  }
  if (config.text.includes("UPDATE lcm.ingest_checkpoints")) {
    return result([checkpointRow]);
  }
  if (
    config.text.includes("FROM lcm.ingest_checkpoints")
    && !config.text.includes("FOR UPDATE")
  ) {
    return result([checkpointRow]);
  }
  if (config.text.includes("FROM lcm.native_transcripts AS transcript")) {
    return result([transcriptRow]);
  }
  throw new Error(`unexpected SQL: ${config.text}`);
}

function scopedExecutor(
  query: ReturnType<typeof vi.fn>,
): PostgreSqlNativeTranscriptScopedExecutor {
  return {
    transactionScope: "active",
    query,
    savepoint: async (callback) => callback({ query }),
  };
}

describe("PostgreSQL native transcript repository", () => {
  it("requires a client-root-relative source locator before executor access", async () => {
    for (const sourceLocator of [
      "/absolute",
      "\\absolute",
      "\\\\server\\share",
      "C:\\absolute",
      "C:/absolute",
      "C:relative",
      "../outside",
      "nested/../outside",
      "nested\\..\\outside",
    ]) {
      const db = executor(successfulQuery);
      const repository = new PostgreSqlNativeTranscriptRepository(
        db,
        projectId,
      );
      const key = {
        machineId,
        clientName: "codex",
        sourceLocator,
      };
      await expect(repository.ingestBatch({
        ...batch,
        ...key,
        expectedCheckpoint: null,
      })).rejects.toBeInstanceOf(PostgreSqlNativeTranscriptDataError);
      await expect(repository.getCheckpoint(key))
        .rejects.toBeInstanceOf(PostgreSqlNativeTranscriptDataError);
      await expect(repository.listBySource(key))
        .rejects.toBeInstanceOf(PostgreSqlNativeTranscriptDataError);
      expect(db.query).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    }

    const db = executor(successfulQuery);
    const repository = new PostgreSqlNativeTranscriptRepository(db, projectId);
    for (const sourceLocator of [
      "foo..bar",
      "dir/.../file",
      "資料/😀.jsonl",
    ]) {
      await expect(repository.listBySource({
        machineId,
        clientName: "codex",
        sourceLocator,
      })).resolves.toHaveLength(1);
    }
  });

  it("captures validated point-query properties exactly once", async () => {
    const db = executor(successfulQuery);
    const repository = new PostgreSqlNativeTranscriptRepository(db, projectId);
    const sessionReads = vi.fn()
      .mockReturnValueOnce("session-a")
      .mockReturnValue("unsafe-session");
    const nativeSessionInput = {} as { readonly nativeSessionId: string };
    Object.defineProperty(nativeSessionInput, "nativeSessionId", {
      enumerable: true,
      get: sessionReads,
    });

    await expect(repository.listByNativeSession(nativeSessionInput))
      .resolves.toHaveLength(1);
    expect(sessionReads).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenLastCalledWith(expect.objectContaining({
      values: [projectId, "session-a"],
    }), expect.any(Object));

    const conversationReads = vi.fn()
      .mockReturnValueOnce(41)
      .mockReturnValue(-1);
    const messageReads = vi.fn()
      .mockReturnValueOnce(51)
      .mockReturnValue(-1);
    const messageInput = {} as {
      readonly conversationId: number;
      readonly messageId: number;
    };
    Object.defineProperties(messageInput, {
      conversationId: {
        enumerable: true,
        get: conversationReads,
      },
      messageId: {
        enumerable: true,
        get: messageReads,
      },
    });

    await expect(repository.listByMessage(messageInput))
      .resolves.toHaveLength(1);
    expect(conversationReads).toHaveBeenCalledTimes(1);
    expect(messageReads).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenLastCalledWith(expect.objectContaining({
      values: [projectId, 41, 51],
    }), expect.any(Object));
    expect(JSON.stringify(db.query.mock.calls)).not.toContain("unsafe-session");
  });

  it("atomically imports records and exposes every provenance query", async () => {
    const db = executor(successfulQuery);
    const repository = new PostgreSqlNativeTranscriptRepository(db, projectId);

    await expect(repository.ingestBatch(batch)).resolves.toMatchObject({
      importedCount: 1,
      skippedCount: 0,
      quarantinedCount: 2,
      checkpoint: {
        projectId,
        importedCount: 1,
        checkpoint: { byteOffset: 42 },
      },
    });
    await expect(repository.getById(transcriptId)).resolves.toMatchObject({
      transcriptId,
      projectId,
      sourceOrdinal: 3,
      observedAt: new Date("2026-01-01T00:00:00.000Z"),
      messageLinks: [{
        transcriptId,
        conversationId: 41,
        messageId: 51,
        sourceOrdinal: 0,
      }],
    });
    await expect(repository.listByNativeSession({
      nativeSessionId: "session-a",
    })).resolves.toHaveLength(1);
    await expect(repository.listBySource(batch)).resolves.toHaveLength(1);
    await expect(repository.listByMessage({
      conversationId: 41,
      messageId: 51,
    })).resolves.toHaveLength(1);
    await expect(repository.getCheckpoint(batch)).resolves.toMatchObject({
      lastSourceOrdinal: 3,
      quarantinedCount: 2,
    });

    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), {
      domain: "native-transcripts",
      operation: "ingestBatch",
      projectId,
    });
    expect(db.query.mock.calls.slice(0, 2).map(([config]) => config.text))
      .toEqual([
        "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
        expect.stringContaining("INSERT INTO lcm.ingest_checkpoints"),
      ]);
    for (const [config, options] of db.query.mock.calls) {
      expect(options).toMatchObject({
        domain: "native-transcripts",
        projectId,
      });
      expect(config.text).not.toContain("session-a");
      expect(config.text).not.toContain("hello");
    }
    const sessionQuery = db.query.mock.calls.find(
      ([config]) => config.text.includes("native_session_id_sha256"),
    )?.[0];
    expect(sessionQuery).toMatchObject({ values: [projectId, "session-a"] });
    expect(sessionQuery.text).toContain("AND transcript.native_session_id = $2");
    const transcriptInsert = db.query.mock.calls.find(
      ([config]) => config.text.includes("INSERT INTO lcm.native_transcripts"),
    )?.[0];
    expect(transcriptInsert?.text).toContain(
      "source_ordinal, observed_at, ingested_at, scrubber_version",
    );
    expect(transcriptInsert?.text).toContain("$7, $8, $9, $9, $10");
    expect(db.query.mock.calls.find(([config]) =>
      config.text.includes("jsonb_agg"))?.[0].text).toContain(
        "link.source_ordinal,\n                        link.message_id,\n                        link.conversation_id",
      );
  });

  it("snapshots mutable batches before the transaction and rejects accessors", async () => {
    let releaseTransaction!: () => void;
    const transactionGate = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    const db = executor(successfulQuery);
    db.transaction.mockImplementationOnce(async (callback) => {
      await transactionGate;
      return callback(db);
    });
    const mutablePayload = {
      type: "message",
      nested: { value: "original" },
    };
    const mutableLink = {
      conversationId: 41,
      messageId: 51,
      sourceOrdinal: 0,
    };
    const mutableCheckpoint = {
      byteOffset: 42,
      nested: { value: "original" },
    };
    const observedAt = new Date("2026-01-01T00:00:00.000Z");
    const mutableBatch: NativeTranscriptBatchInput = {
      ...batch,
      records: [{
        ...batch.records[0]!,
        observedAt,
        nativePayload: mutablePayload,
        messageLinks: [mutableLink],
      }],
      checkpoint: {
        ...batch.checkpoint,
        checkpoint: mutableCheckpoint,
      },
    };
    const repository = new PostgreSqlNativeTranscriptRepository(db, projectId);
    const pending = repository.ingestBatch(mutableBatch);
    observedAt.setUTCFullYear(2030);
    mutablePayload.nested.value = "mutated";
    mutableLink.messageId = 999;
    mutableCheckpoint.byteOffset = 999;
    mutableCheckpoint.nested.value = "mutated";
    releaseTransaction();
    await expect(pending).resolves.toMatchObject({ importedCount: 1 });

    const transcriptInsert = db.query.mock.calls.find(([config]) =>
      config.text.includes("INSERT INTO lcm.native_transcripts"))?.[0];
    expect(transcriptInsert?.values?.[8]).toEqual(
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(transcriptInsert?.values?.[12]).toBe(JSON.stringify({
      nested: { value: "original" },
      type: "message",
    }));
    const linkInsert = db.query.mock.calls.find(([config]) =>
      config.text.includes("INSERT INTO lcm.transcript_messages"))?.[0];
    expect(linkInsert?.values?.[3]).toBe(51);
    const checkpointUpdate = db.query.mock.calls.find(([config]) =>
      config.text.includes("UPDATE lcm.ingest_checkpoints"))?.[0];
    expect(checkpointUpdate?.values?.[8]).toBe(JSON.stringify({
      byteOffset: 42,
      nested: { value: "original" },
    }));

    const accessor = vi.fn(() => ({ unsafe: true }));
    const accessorPayload = {};
    Object.defineProperty(accessorPayload, "secret", {
      enumerable: true,
      get: accessor,
    });
    await expect(repository.ingestBatch({
      ...batch,
      records: [{
        ...batch.records[0]!,
        nativePayload: accessorPayload as never,
      }],
    })).rejects.toBeInstanceOf(PostgreSqlNativeTranscriptDataError);
    expect(accessor).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("rejects lone surrogates at every text boundary and accepts valid pairs", async () => {
    const db = executor(successfulQuery);
    const repository = new PostgreSqlNativeTranscriptRepository(db, projectId);
    const invalid = [
      { ...batch, clientName: "bad\ud800" },
      { ...batch, sourceLocator: "bad\udc00" },
      {
        ...batch,
        records: [{
          ...batch.records[0]!,
          nativeSessionId: "bad\ud800",
        }],
      },
      {
        ...batch,
        records: [{
          ...batch.records[0]!,
          nativePayload: { value: "bad\ud800" },
        }],
      },
      {
        ...batch,
        records: [{
          ...batch.records[0]!,
          nativePayload: { ["bad\udc00"]: "value" },
        }],
      },
      {
        ...batch,
        checkpoint: {
          ...batch.checkpoint,
          checkpoint: { value: "bad\udc00" },
        },
      },
    ] satisfies NativeTranscriptBatchInput[];
    for (const candidate of invalid) {
      await expect(repository.ingestBatch(candidate))
        .rejects.toBeInstanceOf(PostgreSqlNativeTranscriptDataError);
    }
    expect(db.transaction).not.toHaveBeenCalled();

    await expect(repository.ingestBatch({
      ...batch,
      sourceLocator: "sessions/\ud83d\ude00.jsonl",
      records: [{
        ...batch.records[0]!,
        nativePayload: {
          ["key-\ud83d\ude00"]: "value-\ud83d\ude00",
        },
      }],
    })).resolves.toMatchObject({ importedCount: 1 });
  });

  it("rejects lossy JSON numbers and preserves safe numeric values", async () => {
    const rejectingDb = executor(() => {
      throw new Error("database must not be called");
    });
    const rejectingRepository = new PostgreSqlNativeTranscriptRepository(
      rejectingDb,
      projectId,
    );
    for (const value of [
      Number.MAX_SAFE_INTEGER + 1,
      Number.MIN_SAFE_INTEGER - 1,
      -0,
    ]) {
      await expect(rejectingRepository.ingestBatch({
        ...batch,
        records: [{
          ...batch.records[0]!,
          nativePayload: { value },
        }],
      })).rejects.toBeInstanceOf(PostgreSqlNativeTranscriptDataError);
    }
    expect(rejectingDb.query).not.toHaveBeenCalled();
    expect(rejectingDb.transaction).not.toHaveBeenCalled();

    const acceptingDb = executor(successfulQuery);
    const acceptingRepository = new PostgreSqlNativeTranscriptRepository(
      acceptingDb,
      projectId,
    );
    await expect(acceptingRepository.ingestBatch({
      ...batch,
      records: [{
        ...batch.records[0]!,
        nativePayload: {
          fraction: 0.125,
          maximumSafeInteger: Number.MAX_SAFE_INTEGER,
          minimumSafeInteger: Number.MIN_SAFE_INTEGER,
          negativeFraction: -0.5,
          zero: 0,
        },
      }],
    })).resolves.toMatchObject({ importedCount: 1 });
    const transcriptInsert = acceptingDb.query.mock.calls.find(([config]) =>
      config.text.includes("INSERT INTO lcm.native_transcripts"))?.[0];
    expect(transcriptInsert?.values?.[12]).toBe(JSON.stringify({
      fraction: 0.125,
      maximumSafeInteger: Number.MAX_SAFE_INTEGER,
      minimumSafeInteger: Number.MIN_SAFE_INTEGER,
      negativeFraction: -0.5,
      zero: 0,
    }));
  });

  it("canonicalizes caller UUIDs across readback and multi-batch checkpoints", async () => {
    const upperProjectId = projectId.toUpperCase();
    const upperMachineId = machineId.toUpperCase();
    const secondCheckpointRow = {
      ...checkpointRow,
      last_source_ordinal: "4",
      imported_count: "2",
      quarantined_count: "4",
      checkpoint: {
        byteOffset: 84,
        prefixSha256: "d".repeat(64),
      },
    };
    let updateCount = 0;
    const db = executor((config) => {
      if (config.text.includes("INSERT INTO lcm.ingest_checkpoints")) {
        return result(updateCount === 0 ? [initialCheckpointRow] : []);
      }
      if (config.text.includes("FOR UPDATE")) {
        return result([checkpointRow]);
      }
      if (
        config.text.includes("FROM lcm.native_transcripts AS transcript")
        && config.text.includes("exact_match")
      ) {
        return result([{ ...transcriptRow, exact_match: true }]);
      }
      if (config.text.includes("UPDATE lcm.ingest_checkpoints")) {
        updateCount += 1;
        return result([
          updateCount === 1 ? checkpointRow : secondCheckpointRow,
        ]);
      }
      return successfulQuery(config);
    });
    const repository = new PostgreSqlNativeTranscriptRepository(
      db,
      upperProjectId,
    );
    const upperBatch = { ...batch, machineId: upperMachineId };
    const first = await repository.ingestBatch(upperBatch);
    expect(first.checkpoint).toMatchObject({
      projectId,
      machineId,
    });
    const secondBatch: NativeTranscriptBatchInput = {
      ...upperBatch,
      expectedCheckpoint: {
        ...first.checkpoint,
        projectId: upperProjectId,
        machineId: upperMachineId,
      },
      records: [{
        ...upperBatch.records[0]!,
        sourceOrdinal: 4,
        ingestKey: "c".repeat(64),
      }],
      checkpoint: {
        lastSourceOrdinal: 4,
        checkpoint: {
          byteOffset: 84,
          prefixSha256: "d".repeat(64),
        },
      },
    };
    await expect(repository.ingestBatch(secondBatch)).resolves.toMatchObject({
      importedCount: 1,
      skippedCount: 0,
      checkpoint: {
        projectId,
        machineId,
        lastSourceOrdinal: 4,
        importedCount: 2,
      },
    });
    await expect(repository.getById(transcriptId.toUpperCase()))
      .resolves.toMatchObject({ transcriptId, projectId, machineId });
    await expect(repository.listBySource(upperBatch)).resolves.toHaveLength(1);
    await expect(repository.getCheckpoint(upperBatch)).resolves.toMatchObject({
      projectId,
      machineId,
    });
    for (const [config, options] of db.query.mock.calls) {
      expect(config.values ?? []).not.toContain(upperProjectId);
      expect(config.values ?? []).not.toContain(upperMachineId);
      expect(config.values ?? []).not.toContain(transcriptId.toUpperCase());
      expect(options).toMatchObject({ projectId });
    }
  });

  it("loads one server-filtered exact session message snapshot", async () => {
    const rows = [{
      conversation_id: "41",
      message_id: 51n,
      message_sequence: "0",
      role: "user",
      content: "first",
    }, {
      conversation_id: 42,
      message_id: "52",
      message_sequence: 0n,
      role: "assistant",
      content: "second",
    }];
    const db = executor((config) =>
      config.text.includes("FROM lcm.conversations AS conversation")
        ? result(rows)
        : successfulQuery(config));
    const repository = new PostgreSqlNativeTranscriptRepository(db, projectId);
    await expect(repository.getNativeTranscriptMessageSnapshot("session-a"))
      .resolves.toEqual([
        {
          conversationId: 41,
          messageId: 51,
          messageSequence: 0,
          role: "user",
          content: "first",
        },
        {
          conversationId: 42,
          messageId: 52,
          messageSequence: 0,
          role: "assistant",
          content: "second",
        },
      ]);
    expect(db.query).toHaveBeenCalledTimes(1);
    const query = db.query.mock.calls[0]?.[0];
    expect(query.values).toEqual([projectId, "session-a"]);
    expect(query.text).toContain("conversation.session_id_sha256");
    expect(query.text).toContain("conversation.session_id = $2");
    expect(query.text).toContain("ORDER BY conversation.created_at");

    for (const [field, value] of [
      ["conversation_id", "-1"],
      ["message_id", "-1"],
      ["message_sequence", "-1"],
      ["role", "developer"],
      ["content", "bad\0content"],
    ] as const) {
      const malformed = executor(() =>
        result([{ ...rows[0], [field]: value }]));
      await expect(
        new PostgreSqlNativeTranscriptRepository(malformed, projectId)
          .getNativeTranscriptMessageSnapshot("session-a"),
      ).rejects.toMatchObject({
        name: "PostgreSqlNativeTranscriptDataError",
        field,
      });
    }
  });

  it("preserves nested own special JSON keys on write and row normalization", async () => {
    const specialPayload = JSON.parse(`{
      "nested": {
        "__proto__": {"polluted": false},
        "constructor": {"name": "safe"},
        "prototype": ["retained"]
      }
    }`) as NativeTranscriptBatchInput["records"][number]["nativePayload"];
    const specialCheckpoint = JSON.parse(`{
      "__proto__": {"checkpoint": true},
      "nested": {"constructor": "retained"}
    }`) as NativeTranscriptBatchInput["checkpoint"]["checkpoint"];
    const specialCheckpointRow = {
      ...checkpointRow,
      checkpoint: specialCheckpoint,
    };
    const specialTranscriptRow = {
      ...transcriptRow,
      native_payload: specialPayload,
      message_links: [],
    };
    const db = executor((config) => {
      if (config.text.includes("INSERT INTO lcm.native_transcripts")) {
        return result([specialTranscriptRow]);
      }
      if (config.text.includes("UPDATE lcm.ingest_checkpoints")) {
        return result([specialCheckpointRow]);
      }
      if (config.text.includes("FROM lcm.native_transcripts AS transcript")) {
        return result([specialTranscriptRow]);
      }
      return successfulQuery(config);
    });
    const repository = new PostgreSqlNativeTranscriptRepository(db, projectId);
    await expect(repository.ingestBatch({
      ...batch,
      records: [{
        ...batch.records[0],
        nativePayload: specialPayload,
        messageLinks: undefined,
      }],
      checkpoint: {
        ...batch.checkpoint,
        checkpoint: specialCheckpoint,
      },
    })).resolves.toMatchObject({
      importedCount: 1,
      checkpoint: { checkpoint: specialCheckpoint },
    });

    const insert = db.query.mock.calls.find(
      ([config]) => config.text.includes("INSERT INTO lcm.native_transcripts"),
    )?.[0];
    expect(JSON.parse(insert?.values?.[12] as string)).toEqual(specialPayload);
    const stored = await repository.getById(transcriptId);
    const storedPayload = stored?.nativePayload as Record<string, unknown>;
    const storedNested = storedPayload.nested as Record<string, unknown>;
    expect(Object.getPrototypeOf(storedPayload)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(storedNested)).toBe(Object.prototype);
    expect(Object.hasOwn(storedNested, "__proto__")).toBe(true);
    expect(storedNested).toEqual(specialPayload.nested);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("enforces the shared JSON container-depth limit on inputs and rows", async () => {
    for (const kind of ["array", "object"] as const) {
      const exactLimit = nestedContainer(
        NATIVE_TRANSCRIPT_MAX_JSON_DEPTH,
        kind,
      );
      const accepted = executor((config) => {
        if (config.text.includes("INSERT INTO lcm.native_transcripts")) {
          return result([{
            ...transcriptRow,
            native_payload: exactLimit,
            message_links: [],
          }]);
        }
        if (config.text.includes("FROM lcm.native_transcripts AS transcript")) {
          return result([{ ...transcriptRow, native_payload: exactLimit }]);
        }
        return successfulQuery(config);
      });
      const acceptedRepository = new PostgreSqlNativeTranscriptRepository(
        accepted,
        projectId,
      );
      await expect(acceptedRepository.ingestBatch({
        ...batch,
        records: [{
          ...batch.records[0],
          nativePayload: exactLimit,
          messageLinks: undefined,
        }],
      })).resolves.toMatchObject({ importedCount: 1 });
      await expect(acceptedRepository.getById(transcriptId)).resolves
        .toMatchObject({ nativePayload: exactLimit });

      const tooDeep = nestedContainer(
        NATIVE_TRANSCRIPT_MAX_JSON_DEPTH + 1,
        kind,
      );
      const rejectedInput = executor(() => {
        throw new Error("database must not be called");
      });
      await expect(
        new PostgreSqlNativeTranscriptRepository(rejectedInput, projectId)
          .ingestBatch({
            ...batch,
            records: [{
              ...batch.records[0],
              nativePayload: tooDeep,
            }],
          }),
      ).rejects.toMatchObject({
        name: "PostgreSqlNativeTranscriptDataError",
        field: "native_payload",
      });
      expect(rejectedInput.query).not.toHaveBeenCalled();

      const rejectedRow = executor(() =>
        result([{ ...transcriptRow, native_payload: tooDeep }]));
      await expect(
        new PostgreSqlNativeTranscriptRepository(rejectedRow, projectId)
          .getById(transcriptId),
      ).rejects.toMatchObject({
        name: "PostgreSqlNativeTranscriptDataError",
        field: "native_payload",
      });
    }
  });

  it("skips exact ingest-key retries and rejects record or linkage collisions", async () => {
    let exactMatchQuery: QueryConfig<unknown[]> | undefined;
    const exact = executor((config) => {
      if (config.text.includes("INSERT INTO lcm.native_transcripts")) {
        return result([]);
      }
      if (
        config.text.includes("FROM lcm.native_transcripts AS transcript")
        && config.text.includes("exact_match")
      ) {
        exactMatchQuery = config;
        return result([{
          ...transcriptRow,
          observed_at: "2026-01-01T00:00:00.000Z",
          scrubber_version: "first-stored-scrubber",
          exact_match: true,
        }]);
      }
      return successfulQuery(config);
    });
    await expect(
      new PostgreSqlNativeTranscriptRepository(exact, projectId)
        .ingestBatch({
          ...batch,
          records: [{
            ...batch.records[0],
            observedAt: new Date("2026-02-01T00:00:00.000Z"),
            scrubberVersion: "later-scrubber",
          }],
        }),
    ).resolves.toMatchObject({ importedCount: 0, skippedCount: 1 });
    expect(exactMatchQuery?.text).toContain(
      "AND transcript.source_ordinal = $8",
    );
    expect(exactMatchQuery?.text).not.toContain(
      "transcript.observed_at =",
    );
    expect(exactMatchQuery?.text).not.toContain(
      "transcript.scrubber_version =",
    );
    expect(exactMatchQuery?.values).toEqual([
      projectId,
      machineId,
      "codex",
      "codex-jsonl",
      "v1",
      "session-a",
      "sessions/a.jsonl",
      3,
      contentSha256,
      ingestKey,
      JSON.stringify({
        nested: [true, 1, null],
        text: "hello",
        type: "message",
      }),
    ]);

    for (const collisionRow of [
      undefined,
      { ...transcriptRow, exact_match: false },
      { ...transcriptRow, exact_match: true, message_links: [] },
    ]) {
      const collision = executor((config) => {
        if (config.text.includes("INSERT INTO lcm.native_transcripts")) {
          return result([]);
        }
        if (
          config.text.includes("FROM lcm.native_transcripts AS transcript")
          && config.text.includes("exact_match")
        ) {
          return result(collisionRow ? [collisionRow] : []);
        }
        return successfulQuery(config);
      });
      const error = await new PostgreSqlNativeTranscriptRepository(
        collision,
        projectId,
      ).ingestBatch(batch).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(PostgreSqlNativeTranscriptConflictError);
      expect(error).toMatchObject({
        domain: "native-transcripts",
        operation: "ingestBatch",
        ingestKey,
      });
      expect((error as PostgreSqlNativeTranscriptConflictError).toJSON())
        .toMatchObject({ ingestKey });
    }
  });

  it("compares the exact expected prior checkpoint before writing", async () => {
    const existing = executor((config) => {
      if (config.text.includes("INSERT INTO lcm.ingest_checkpoints")) {
        return result([]);
      }
      return successfulQuery(config);
    });
    await expect(
      new PostgreSqlNativeTranscriptRepository(existing, projectId)
        .ingestBatch({
          ...batch,
          expectedCheckpoint: checkpointRecord,
          records: [],
          checkpoint: {
            lastSourceOrdinal: 0,
            checkpoint: { byteOffset: 0, prefixSha256: "0".repeat(64) },
          },
          quarantinedCount: 0,
        }),
    ).resolves.toMatchObject({
      checkpoint: { lastSourceOrdinal: 3 },
    });

    for (const expectedCheckpoint of [
      null,
      { ...checkpointRecord, importedCount: 2 },
      { ...checkpointRecord, skippedCount: 1 },
      { ...checkpointRecord, quarantinedCount: 3 },
      { ...checkpointRecord, lastSourceOrdinal: 4 },
      { ...checkpointRecord, checkpoint: { byteOffset: 43 } },
    ]) {
      const stale = executor((config) => {
        if (config.text.includes("INSERT INTO lcm.ingest_checkpoints")) {
          return result([]);
        }
        return successfulQuery(config);
      });
      await expect(
        new PostgreSqlNativeTranscriptRepository(stale, projectId)
          .ingestBatch({
            ...batch,
            expectedCheckpoint,
            checkpoint: {
              lastSourceOrdinal: 4,
              checkpoint: {
                byteOffset: 43,
                prefixSha256: "d".repeat(64),
              },
            },
          }),
      ).rejects.toMatchObject({
        name: "PostgreSqlNativeTranscriptCheckpointConflictError",
      });
      expect(stale.query.mock.calls.some(
        ([config]) => config.text.includes("INSERT INTO lcm.native_transcripts"),
      )).toBe(false);
    }

    const unexpectedCreation = executor(successfulQuery);
    await expect(
      new PostgreSqlNativeTranscriptRepository(unexpectedCreation, projectId)
        .ingestBatch({ ...batch, expectedCheckpoint: checkpointRecord }),
    ).rejects.toMatchObject({
      name: "PostgreSqlNativeTranscriptCheckpointConflictError",
    });
    expect(unexpectedCreation.query).toHaveBeenCalledTimes(2);
  });

  it("converges concurrent first-empty checkpoint writers as a retry", async () => {
    const emptyCheckpoint = {
      version: 1,
      byteOffset: 0,
      prefixSha256: contentSha256,
      scrubberVersion: `pipeline:${ingestKey}`,
      source: {
        sizeBytes: 0,
        modifiedAtMs: 1,
        changedAtMs: 1,
      },
    };
    const emptyCheckpointRow = {
      ...initialCheckpointRow,
      checkpoint: emptyCheckpoint,
      updated_at: "2026-01-01T00:00:01.000Z",
    };
    const emptyBatch: NativeTranscriptBatchInput = {
      ...batch,
      expectedCheckpoint: null,
      records: [],
      checkpoint: {
        lastSourceOrdinal: 0,
        checkpoint: emptyCheckpoint,
      },
      quarantinedCount: 0,
    };
    const first = executor((config) => {
      if (config.text.includes("INSERT INTO lcm.ingest_checkpoints")) {
        return result([initialCheckpointRow]);
      }
      if (config.text.includes("UPDATE lcm.ingest_checkpoints")) {
        return result([emptyCheckpointRow]);
      }
      return successfulQuery(config);
    });
    await expect(
      new PostgreSqlNativeTranscriptRepository(first, projectId)
        .ingestBatch(emptyBatch),
    ).resolves.toMatchObject({
      importedCount: 0,
      skippedCount: 0,
      checkpoint: { checkpoint: emptyCheckpoint },
    });

    const retry = executor((config) => {
      if (config.text.includes("INSERT INTO lcm.ingest_checkpoints")) {
        return result([]);
      }
      if (config.text.includes("FOR UPDATE")) {
        return result([emptyCheckpointRow]);
      }
      if (config.text.includes("UPDATE lcm.ingest_checkpoints")) {
        return result([emptyCheckpointRow]);
      }
      return successfulQuery(config);
    });
    await expect(
      new PostgreSqlNativeTranscriptRepository(retry, projectId)
        .ingestBatch(emptyBatch),
    ).resolves.toMatchObject({
      importedCount: 0,
      skippedCount: 0,
      checkpoint: { checkpoint: emptyCheckpoint },
    });
  });

  it("rebases matching stale retries without admitting new records", async () => {
    const retryCheckpointRow = {
      ...checkpointRow,
      skipped_count: "1",
      quarantined_count: "4",
    };
    const matching = executor((config) => {
      if (config.text.includes("INSERT INTO lcm.ingest_checkpoints")) {
        return result([]);
      }
      if (
        config.text.includes("FROM lcm.native_transcripts AS transcript")
        && config.text.includes("exact_match")
      ) {
        return result([{ ...transcriptRow, exact_match: true }]);
      }
      if (config.text.includes("UPDATE lcm.ingest_checkpoints")) {
        return result([retryCheckpointRow]);
      }
      return successfulQuery(config);
    });
    const repository = new PostgreSqlNativeTranscriptRepository(
      matching,
      projectId,
    );
    await expect(repository.ingestBatch(batch)).resolves.toMatchObject({
      importedCount: 0,
      skippedCount: 1,
      quarantinedCount: 2,
      checkpoint: {
        importedCount: 1,
        skippedCount: 1,
        quarantinedCount: 4,
      },
    });
    expect(matching.query.mock.calls.some(
      ([config]) => config.text.includes("INSERT INTO lcm.native_transcripts"),
    )).toBe(false);

    const checkpointOnly = executor((config) => {
      if (config.text.includes("INSERT INTO lcm.ingest_checkpoints")) {
        return result([]);
      }
      if (config.text.includes("UPDATE lcm.ingest_checkpoints")) {
        return result([retryCheckpointRow]);
      }
      return successfulQuery(config);
    });
    await expect(
      new PostgreSqlNativeTranscriptRepository(checkpointOnly, projectId)
        .ingestBatch({ ...batch, records: [] }),
    ).resolves.toMatchObject({
      importedCount: 0,
      skippedCount: 0,
      quarantinedCount: 2,
      checkpoint: { quarantinedCount: 4 },
    });
    expect(checkpointOnly.query.mock.calls.some(
      ([config]) => config.text.includes("lcm.native_transcripts"),
    )).toBe(false);
  });

  it("reconciles a committed batch after an uncertain commit outcome", async () => {
    const advancedCheckpointRow = {
      ...checkpointRow,
      skipped_count: "1",
      quarantined_count: "4",
    };
    const reconciled = executor(
      (config) => {
        if (
          config.text.includes("FROM lcm.ingest_checkpoints")
          && !config.text.includes("FOR UPDATE")
        ) {
          return result([{
            ...advancedCheckpointRow,
            checkpoint: {
              prefixSha256: "c".repeat(64),
              byteOffset: 42,
            },
          }]);
        }
        if (
          config.text.includes("FROM lcm.native_transcripts AS transcript")
          && config.text.includes("exact_match")
        ) {
          return result([{ ...transcriptRow, exact_match: true }]);
        }
        return successfulQuery(config);
      },
      () => {
        throw new PostgreSqlCommitOutcomeUnknownError({
          domain: "native-transcripts",
          operation: "ingestBatch",
          projectId,
        });
      },
    );
    await expect(
      new PostgreSqlNativeTranscriptRepository(reconciled, projectId)
        .ingestBatch(batch),
    ).resolves.toMatchObject({
      importedCount: 1,
      checkpoint: {
        projectId,
        importedCount: 1,
        skippedCount: 1,
        quarantinedCount: 4,
      },
    });

    for (const collisionRow of [
      undefined,
      { ...transcriptRow, exact_match: false },
      { ...transcriptRow, exact_match: true, message_links: [] },
    ]) {
      const mismatch = executor(
        (config) => {
          if (
            config.text.includes("FROM lcm.ingest_checkpoints")
            && !config.text.includes("FOR UPDATE")
          ) {
            return result([advancedCheckpointRow]);
          }
          if (
            config.text.includes("FROM lcm.native_transcripts AS transcript")
            && config.text.includes("exact_match")
          ) {
            return result(collisionRow ? [collisionRow] : []);
          }
          return successfulQuery(config);
        },
        () => {
          throw new PostgreSqlCommitOutcomeUnknownError({
            domain: "native-transcripts",
            operation: "ingestBatch",
            projectId,
          });
        },
      );
      await expect(
        new PostgreSqlNativeTranscriptRepository(mismatch, projectId)
          .ingestBatch(batch),
      ).rejects.toBeInstanceOf(PostgreSqlCommitOutcomeUnknownError);
    }
  });

  it("serializes transaction-scoped access and rejects untrusted scope markers", async () => {
    const query = vi.fn(successfulQuery);
    const scoped = new PostgreSqlNativeTranscriptRepository(
      scopedExecutor(query),
      projectId,
    );
    await expect(scoped.ingestBatch({ ...batch, records: [] })).resolves
      .toMatchObject({ importedCount: 0 });
    await expect(scoped.getCheckpoint(batch)).resolves.toMatchObject({
      projectId,
    });

    const invalid = new PostgreSqlNativeTranscriptRepository(
      { query } as unknown as PostgreSqlNativeTranscriptScopedExecutor,
      projectId,
    );
    await expect(invalid.getCheckpoint(batch)).rejects.toMatchObject({
      code: "STORAGE_TRANSACTION_SCOPE",
      domain: "native-transcripts",
    });
  });

  it("fails a supplied stronger-isolation scope before checkpoint access", async () => {
    for (const rows of [
      [],
      [{ transaction_isolation: "repeatable read" }],
      [{ transaction_isolation: 42 }],
    ]) {
      const query = vi.fn((config: QueryConfig<unknown[]>) =>
        config.text.includes("transaction_isolation")
          ? result(rows)
          : (() => {
              throw new Error(
                `unexpected checkpoint access: ${config.text}`,
              );
            })());
      const repository = new PostgreSqlNativeTranscriptRepository(
        scopedExecutor(query),
        projectId,
      );
      await expect(repository.ingestBatch(batch)).rejects.toMatchObject({
        name: "PostgreSqlNativeTranscriptDataError",
        field: "transaction_isolation",
        operation: "ingestBatch",
      });
      expect(query).toHaveBeenCalledTimes(1);
    }
  });

  it("normalizes a supplied read-committed isolation setting", async () => {
    const query = vi.fn((config: QueryConfig<unknown[]>) =>
      config.text.includes("transaction_isolation")
        ? result([{ transaction_isolation: " \tREAD COMMITTED\n" }])
        : successfulQuery(config));
    const repository = new PostgreSqlNativeTranscriptRepository(
      scopedExecutor(query),
      projectId,
    );
    await expect(repository.ingestBatch({
      ...batch,
      records: [],
    })).resolves.toMatchObject({ importedCount: 0 });
    expect(query.mock.calls[0]?.[0].text).toContain(
      "transaction_isolation",
    );
    expect(query.mock.calls.some(([config]) =>
      config.text.includes("INSERT INTO lcm.ingest_checkpoints"))).toBe(true);
  });

  it("returns null for absent point reads and fails closed on malformed rows", async () => {
    const absent = executor(() => result([]));
    const repository = new PostgreSqlNativeTranscriptRepository(
      absent,
      projectId,
    );
    await expect(repository.getById(transcriptId)).resolves.toBeNull();
    await expect(repository.getCheckpoint(batch)).resolves.toBeNull();

    for (const [field, value] of [
      ["project_id", machineId],
      ["transcript_id", "not-a-uuid"],
      ["machine_id", "not-a-uuid"],
      ["source_ordinal", "-1"],
      ["observed_at", "not-a-date"],
      ["content_sha256", "not-a-digest"],
      ["native_payload", "scalar"],
      ["message_links", {}],
    ] as const) {
      const malformed = executor(() =>
        result([{ ...transcriptRow, [field]: value }]));
      await expect(
        new PostgreSqlNativeTranscriptRepository(malformed, projectId)
          .getById(transcriptId),
      ).rejects.toMatchObject({
        name: "PostgreSqlNativeTranscriptDataError",
      });
    }

    const malformedLink = executor(() =>
      result([{ ...transcriptRow, message_links: [null] }]));
    await expect(
      new PostgreSqlNativeTranscriptRepository(malformedLink, projectId)
        .getById(transcriptId),
    ).rejects.toBeInstanceOf(PostgreSqlNativeTranscriptDataError);
  });

  it("validates unsafe inputs before invoking PostgreSQL", async () => {
    const db = executor(() => {
      throw new Error("database must not be called");
    });
    const repository = new PostgreSqlNativeTranscriptRepository(db, projectId);

    const invalidBatches: NativeTranscriptBatchInput[] = [
      { ...batch, machineId: "not-a-uuid" },
      {
        ...batch,
        machineId: "018f22c4-6d2a-4f10-8a4c-6b8d3e5f9021",
      },
      { ...batch, clientName: " " },
      { ...batch, sourceLocator: "" },
      { ...batch, quarantinedCount: -1 },
      { ...batch, quarantinedCount: 1.5 },
      { ...batch, quarantinedCount: true as never },
      { ...batch, quarantinedCount: 9_007_199_254_740_992n as never },
      {
        ...batch,
        checkpoint: { ...batch.checkpoint, lastSourceOrdinal: -1 },
      },
      {
        ...batch,
        checkpoint: { ...batch.checkpoint, checkpoint: [] as never },
      },
      {
        ...batch,
        expectedCheckpoint: {
          ...checkpointRecord,
          projectId: "018f22c4-6d2a-4f10-8a4c-6b8d3e5f9020",
        },
      },
      {
        ...batch,
        expectedCheckpoint: {
          ...checkpointRecord,
          machineId: "018f22c4-6d2a-4f10-8a4c-6b8d3e5f9021",
        },
      },
      {
        ...batch,
        expectedCheckpoint: { ...checkpointRecord, clientName: " " },
      },
      {
        ...batch,
        expectedCheckpoint: { ...checkpointRecord, sourceLocator: "" },
      },
      {
        ...batch,
        expectedCheckpoint: { ...checkpointRecord, lastSourceOrdinal: -1 },
      },
      {
        ...batch,
        expectedCheckpoint: { ...checkpointRecord, importedCount: -1 },
      },
      {
        ...batch,
        expectedCheckpoint: { ...checkpointRecord, skippedCount: -1 },
      },
      {
        ...batch,
        expectedCheckpoint: { ...checkpointRecord, quarantinedCount: -1 },
      },
      {
        ...batch,
        expectedCheckpoint: {
          ...checkpointRecord,
          checkpoint: [] as never,
        },
      },
      {
        ...batch,
        expectedCheckpoint: {
          ...checkpointRecord,
          updatedAt: new Date(Number.NaN),
        },
      },
      {
        ...batch,
        expectedCheckpoint: { ...checkpointRecord, projectId: machineId },
      },
      {
        ...batch,
        expectedCheckpoint: { ...checkpointRecord, machineId: transcriptId },
      },
      {
        ...batch,
        expectedCheckpoint: { ...checkpointRecord, clientName: "claude" },
      },
      {
        ...batch,
        expectedCheckpoint: {
          ...checkpointRecord,
          sourceLocator: "sessions/other.jsonl",
        },
      },
      {
        ...batch,
        records: [{ ...batch.records[0], formatName: " " }],
      },
      {
        ...batch,
        records: [{ ...batch.records[0], formatVersion: " " }],
      },
      {
        ...batch,
        records: [{ ...batch.records[0], nativeSessionId: " " }],
      },
      {
        ...batch,
        records: [{ ...batch.records[0], sourceOrdinal: -1 }],
      },
      {
        ...batch,
        records: [{ ...batch.records[0], observedAt: new Date(Number.NaN) }],
      },
      {
        ...batch,
        records: [{ ...batch.records[0], observedAt: 42 as never }],
      },
      {
        ...batch,
        records: [{ ...batch.records[0], scrubberVersion: " " }],
      },
      {
        ...batch,
        records: [{ ...batch.records[0], contentSha256: "x" }],
      },
      {
        ...batch,
        records: [{ ...batch.records[0], ingestKey: "x" }],
      },
      {
        ...batch,
        records: [{
          ...batch.records[0],
          nativePayload: { bad: Number.POSITIVE_INFINITY },
        }],
      },
      {
        ...batch,
        records: [{
          ...batch.records[0],
          nativePayload: { bad: 1n as never },
        }],
      },
      {
        ...batch,
        records: [{
          ...batch.records[0],
          nativePayload: { bad: "\0" },
        }],
      },
      {
        ...batch,
        records: [{
          ...batch.records[0],
          nativePayload: new Date() as never,
        }],
      },
      {
        ...batch,
        records: [{
          ...batch.records[0],
          messageLinks: [{
            conversationId: -1,
            messageId: 51,
            sourceOrdinal: 0,
          }],
        }],
      },
      {
        ...batch,
        records: [{
          ...batch.records[0],
          messageLinks: [{
            conversationId: 41,
            messageId: -1,
            sourceOrdinal: 0,
          }],
        }],
      },
      {
        ...batch,
        records: [{
          ...batch.records[0],
          messageLinks: [{
            conversationId: 41,
            messageId: 51,
            sourceOrdinal: -1,
          }],
        }],
      },
    ];
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    invalidBatches.push({
      ...batch,
      records: [{ ...batch.records[0], nativePayload: cyclic as never }],
    });
    const symbolPayload = { safe: true };
    Object.defineProperty(symbolPayload, Symbol("hidden"), {
      enumerable: true,
      value: "hidden",
    });
    invalidBatches.push({
      ...batch,
      records: [{
        ...batch.records[0],
        nativePayload: symbolPayload as never,
      }],
    }, {
      ...batch,
      records: {} as never,
    });
    const extraRecords = [...batch.records];
    Object.defineProperty(extraRecords, "extra", {
      enumerable: true,
      value: "extra",
    });
    invalidBatches.push({ ...batch, records: extraRecords });
    const accessorRecords = [...batch.records];
    const recordAccessor = vi.fn(() => batch.records[0]);
    Object.defineProperty(accessorRecords, "0", {
      enumerable: true,
      get: recordAccessor,
    });
    invalidBatches.push({ ...batch, records: accessorRecords });

    for (const invalid of invalidBatches) {
      await expect(repository.ingestBatch(invalid))
        .rejects.toBeInstanceOf(PostgreSqlNativeTranscriptDataError);
    }
    expect(recordAccessor).not.toHaveBeenCalled();
    await expect(repository.getById("not-a-uuid"))
      .rejects.toBeInstanceOf(PostgreSqlNativeTranscriptDataError);
    await expect(repository.listByNativeSession({ nativeSessionId: " " }))
      .rejects.toBeInstanceOf(PostgreSqlNativeTranscriptDataError);
    await expect(repository.listByMessage({ conversationId: -1, messageId: 1 }))
      .rejects.toBeInstanceOf(PostgreSqlNativeTranscriptDataError);
    await expect(repository.listByMessage({ conversationId: 1, messageId: -1 }))
      .rejects.toBeInstanceOf(PostgreSqlNativeTranscriptDataError);
    expect(db.query).not.toHaveBeenCalled();

    expect(() => new PostgreSqlNativeTranscriptRepository(db, "not-a-uuid"))
      .toThrow(PostgreSqlNativeTranscriptDataError);
    expect(() => new PostgreSqlNativeTranscriptRepository(
      db,
      "018f22c4-6d2a-4f10-8a4c-6b8d3e5f9020",
    )).toThrow(PostgreSqlNativeTranscriptDataError);
  });

  it("bounds only linked source ordinals to PostgreSQL int4", async () => {
    const maxLinkSourceOrdinal = 2_147_483_647;
    const linked = executor((config) => {
      if (config.text.includes("INSERT INTO lcm.transcript_messages")) {
        return result([{
          ...linkRow,
          source_ordinal: String(maxLinkSourceOrdinal),
        }]);
      }
      return successfulQuery(config);
    });
    await expect(
      new PostgreSqlNativeTranscriptRepository(linked, projectId)
        .ingestBatch({
          ...batch,
          records: [{
            ...batch.records[0],
            messageLinks: [{
              conversationId: 41,
              messageId: 51,
              sourceOrdinal: maxLinkSourceOrdinal,
            }],
          }],
        }),
    ).resolves.toMatchObject({ importedCount: 1 });
    const linkInsert = linked.query.mock.calls.find(([config]) =>
      config.text.includes("INSERT INTO lcm.transcript_messages"))?.[0];
    expect(linkInsert?.values?.[4]).toBe(maxLinkSourceOrdinal);

    const wideOrdinal = maxLinkSourceOrdinal + 1;
    const wideTranscriptRow = {
      ...transcriptRow,
      source_ordinal: String(wideOrdinal),
      message_links: [],
    };
    const wideCheckpointRow = {
      ...checkpointRow,
      last_source_ordinal: String(wideOrdinal),
    };
    const unlinked = executor((config) => {
      if (config.text.includes("INSERT INTO lcm.native_transcripts")) {
        return result([wideTranscriptRow]);
      }
      if (config.text.includes("UPDATE lcm.ingest_checkpoints")) {
        return result([wideCheckpointRow]);
      }
      return successfulQuery(config);
    });
    await expect(
      new PostgreSqlNativeTranscriptRepository(unlinked, projectId)
        .ingestBatch({
          ...batch,
          records: [{
            ...batch.records[0],
            sourceOrdinal: wideOrdinal,
            messageLinks: undefined,
          }],
          checkpoint: {
            ...batch.checkpoint,
            lastSourceOrdinal: wideOrdinal,
          },
        }),
    ).resolves.toMatchObject({
      importedCount: 1,
      checkpoint: { lastSourceOrdinal: wideOrdinal },
    });

    const rejected = executor(() => {
      throw new Error("database must not be called");
    });
    await expect(
      new PostgreSqlNativeTranscriptRepository(rejected, projectId)
        .ingestBatch({
          ...batch,
          records: [{
            ...batch.records[0],
            messageLinks: [{
              conversationId: 41,
              messageId: 51,
              sourceOrdinal: wideOrdinal,
            }],
          }],
        }),
    ).rejects.toMatchObject({
      name: "PostgreSqlNativeTranscriptDataError",
      field: "link_source_ordinal",
    });
    expect(rejected.transaction).not.toHaveBeenCalled();
    expect(rejected.query).not.toHaveBeenCalled();
  });

  it("covers row and reconciliation guards without exposing unsafe data", async () => {
    const dataError = new PostgreSqlNativeTranscriptDataError(
      projectId,
      "probe",
      "field",
    );
    expect(dataError.toJSON()).toMatchObject({ field: "field" });

    const malformedCheckpoint = executor((config) => {
      if (config.text.includes("FROM lcm.ingest_checkpoints")) {
        return result([{ ...checkpointRow, project_id: machineId }]);
      }
      return successfulQuery(config);
    });
    await expect(
      new PostgreSqlNativeTranscriptRepository(malformedCheckpoint, projectId)
        .getCheckpoint(batch),
    ).rejects.toMatchObject({ field: "project_id" });

    const malformedMatch = executor((config) => {
      if (config.text.includes("INSERT INTO lcm.native_transcripts")) {
        return result([]);
      }
      if (config.text.includes("exact_match")) {
        return result([{ ...transcriptRow, exact_match: "true" }]);
      }
      return successfulQuery(config);
    });
    await expect(
      new PostgreSqlNativeTranscriptRepository(malformedMatch, projectId)
        .ingestBatch(batch),
    ).rejects.toMatchObject({ field: "exact_match" });

    const readFailure = executor(
      (config) => {
        if (
          config.text.includes("FROM lcm.ingest_checkpoints")
          && !config.text.includes("FOR UPDATE")
        ) {
          throw new Error("reconciliation unavailable");
        }
        return successfulQuery(config);
      },
      () => {
        throw new PostgreSqlCommitOutcomeUnknownError({
          domain: "native-transcripts",
          operation: "ingestBatch",
          projectId,
        });
      },
    );
    await expect(
      new PostgreSqlNativeTranscriptRepository(readFailure, projectId)
        .ingestBatch(batch),
    ).rejects.toBeInstanceOf(PostgreSqlCommitOutcomeUnknownError);
  });

  it("orders multiple links deterministically and accepts link-free records", async () => {
    const orderedLinks = [
      { conversationId: 42, messageId: 52, sourceOrdinal: 1 },
      { conversationId: 43, messageId: 51, sourceOrdinal: 1 },
      { conversationId: 41, messageId: 51, sourceOrdinal: 0 },
      { conversationId: 42, messageId: 51, sourceOrdinal: 1 },
    ];
    const db = executor(successfulQuery);
    const repository = new PostgreSqlNativeTranscriptRepository(db, projectId);
    await expect(repository.ingestBatch({
      ...batch,
      records: [{
        ...batch.records[0],
        messageLinks: orderedLinks,
      }],
    })).resolves.toMatchObject({ importedCount: 1 });
    const insertedMessages = db.query.mock.calls.filter(
      ([config]) => config.text.includes("INSERT INTO lcm.transcript_messages"),
    );
    expect(insertedMessages.map(([config]) => config.values?.slice(2)))
      .toEqual([
        [41, 51, 0],
        [42, 51, 1],
        [43, 51, 1],
        [42, 52, 1],
      ]);

    await expect(repository.ingestBatch({
      ...batch,
      records: [{
        ...batch.records[0],
        messageLinks: undefined,
      }],
    })).resolves.toMatchObject({ importedCount: 1 });
  });

  it("runs the scoped serialization rejection continuation", async () => {
    const query = vi.fn((config: QueryConfig<unknown[]>) => {
      if (config.text.includes("FROM lcm.ingest_checkpoints")) {
        throw new Error("read failed");
      }
      return successfulQuery(config);
    });
    const repository = new PostgreSqlNativeTranscriptRepository(
      scopedExecutor(query),
      projectId,
    );
    await expect(repository.getCheckpoint(batch)).rejects.toThrow("read failed");
    await expect(repository.getById(transcriptId)).resolves.toMatchObject({
      transcriptId,
    });
  });

  it("fails closed when checkpoint or link mutations return no authoritative row", async () => {
    const missingLock = executor((config) => {
      if (config.text.includes("INSERT INTO lcm.ingest_checkpoints")) {
        return result([]);
      }
      if (config.text.includes("FOR UPDATE")) return result([]);
      return successfulQuery(config);
    });
    await expect(
      new PostgreSqlNativeTranscriptRepository(missingLock, projectId)
        .ingestBatch(batch),
    ).rejects.toMatchObject({ field: "checkpoint" });

    const missingLink = executor((config) => {
      if (config.text.includes("INSERT INTO lcm.transcript_messages")) {
        return result([]);
      }
      return successfulQuery(config);
    });
    await expect(
      new PostgreSqlNativeTranscriptRepository(missingLink, projectId)
        .ingestBatch(batch),
    ).rejects.toMatchObject({ field: "message_link" });

    const missingCheckpoint = executor((config) => {
      if (config.text.includes("UPDATE lcm.ingest_checkpoints")) {
        return result([]);
      }
      return successfulQuery(config);
    });
    await expect(
      new PostgreSqlNativeTranscriptRepository(missingCheckpoint, projectId)
        .ingestBatch(batch),
    ).rejects.toMatchObject({ field: "checkpoint" });
  });
});
