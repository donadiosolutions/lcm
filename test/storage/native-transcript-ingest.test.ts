import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationRepository,
  JsonObject,
  NativeTranscriptBatchInput,
  NativeTranscriptBatchResult,
  NativeTranscriptCheckpointRecord,
  NativeTranscriptRepository,
} from "../../src/storage/contracts.js";
import {
  localTranscriptQuarantinePath,
  openLocalTranscriptQuarantine,
  SQLiteLocalTranscriptQuarantineRepository,
  TRANSCRIPT_QUARANTINE_REASONS,
} from "../../src/storage/local-transcript-quarantine.js";
import {
  canonicalNativeTranscriptJson,
  CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
  CODEX_NATIVE_TRANSCRIPT_FORMAT,
  createFileNativeTranscriptSource,
  createExactNativeTranscriptMessageResolver,
  createNativeTranscriptMessageMapper,
  createNativeTranscriptScrubber,
  NativeTranscriptConfigurationError,
  NativeTranscriptLinkError,
  NATIVE_TRANSCRIPT_MAX_JSON_DEPTH,
  NativeTranscriptSourceChangedError,
  readNativeTranscriptJsonl,
  runNativeTranscriptBackfill,
  SUPPORTED_NATIVE_TRANSCRIPT_FORMATS,
  type NativeTranscriptByteSource,
  type NativeTranscriptReadOutcome,
} from "../../src/storage/native-transcript-ingest.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "lcm-native-transcript-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function* byteChunks(
  ...chunks: Array<string | Uint8Array>
): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    yield typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  }
}

async function collect(
  bytes: AsyncIterable<Uint8Array>,
  overrides: Partial<Parameters<typeof readNativeTranscriptJsonl>[0]> = {},
): Promise<NativeTranscriptReadOutcome[]> {
  return Array.fromAsync(readNativeTranscriptJsonl({
    bytes,
    format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
    nativeSessionId: "session-1",
    sourceLocator: "sessions/session.jsonl",
    scrubber: createNativeTranscriptScrubber(),
    clock: () => new Date("2026-07-25T12:00:00.000Z"),
    ...overrides,
  }));
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function nestedJson(
  depth: number,
  kind: "array" | "object" | "mixed",
): string {
  let result = "0";
  for (let index = 0; index < depth; index += 1) {
    const useArray =
      kind === "array" || (kind === "mixed" && index % 2 === 0);
    result = useArray ? `[${result}]` : `{"value":${result}}`;
  }
  return result;
}

function source(content: string): NativeTranscriptByteSource {
  const bytes = Buffer.from(content);
  return {
    openSnapshot: vi.fn(async () => ({
      metadata: {
        sizeBytes: bytes.byteLength,
        modifiedAtMs: 123,
        changedAtMs: 456,
      },
      stream: () => byteChunks(bytes.subarray(0, 3), bytes.subarray(3)),
      digestPrefix: async (length: number) =>
        digest(bytes.subarray(0, length)),
      assertUnchanged: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    })),
  };
}

function checkpoint(
  checkpointValue: JsonObject,
): NativeTranscriptCheckpointRecord {
  return {
    projectId: "project",
    machineId: "machine",
    clientName: "claude-code",
    sourceLocator: "sessions/session.jsonl",
    lastSourceOrdinal: 0,
    importedCount: 1,
    skippedCount: 0,
    quarantinedCount: 0,
    checkpoint: checkpointValue,
    updatedAt: new Date("2026-07-25T12:00:00.000Z"),
  };
}

function repository(
  existing: NativeTranscriptCheckpointRecord | null = null,
): NativeTranscriptRepository & {
  batches: NativeTranscriptBatchInput[];
} {
  const batches: NativeTranscriptBatchInput[] = [];
  return {
    batches,
    getCheckpoint: vi.fn(async () => existing),
    ingestBatch: vi.fn(async (
      input: NativeTranscriptBatchInput,
    ): Promise<NativeTranscriptBatchResult> => {
      batches.push(input);
      return {
        importedCount: input.records.length,
        skippedCount: 0,
        quarantinedCount: input.quarantinedCount,
        checkpoint: checkpoint(input.checkpoint.checkpoint),
      };
    }),
    getById: vi.fn(async () => null),
    listByNativeSession: vi.fn(async () => []),
    listBySource: vi.fn(async () => []),
    listByMessage: vi.fn(async () => []),
  };
}

describe("native transcript scrub and JSONL reader", () => {
  it("exports the two versioned supported formats", () => {
    expect(SUPPORTED_NATIVE_TRANSCRIPT_FORMATS).toEqual([
      {
        clientName: "claude-code",
        formatName: "claude-jsonl",
        formatVersion: "v1",
      },
      {
        clientName: "codex",
        formatName: "codex-jsonl",
        formatVersion: "v1",
      },
    ]);
    expect(CODEX_NATIVE_TRANSCRIPT_FORMAT.clientName).toBe("codex");
  });

  it("scrubs nested keys and values and canonicalizes object keys", () => {
    const scrubber = createNativeTranscriptScrubber({
      globalPatterns: ["canary_[0-9]+"],
      pipelineVersion: "pipeline/v2",
    });
    const scrubbed = scrubber.scrubJson({
      z: ["canary_123", { canary_456: "safe" }],
      a: true,
    });
    expect(scrubbed).toEqual({
      z: ["[REDACTED]", { "[REDACTED]": "safe" }],
      a: true,
    });
    expect(scrubber.scrubberVersion).toMatch(
      /^pipeline\/v2:[0-9a-f]{64}$/u,
    );
    expect(canonicalNativeTranscriptJson(scrubbed)).toBe(
      '{"a":true,"z":["[REDACTED]",{"[REDACTED]":"safe"}]}',
    );
    expect(canonicalNativeTranscriptJson(null)).toBe("null");
    expect(canonicalNativeTranscriptJson("x")).toBe('"x"');
  });

  it("rejects invalid scrubber configuration before use", () => {
    expect(() =>
      createNativeTranscriptScrubber({ globalPatterns: ["["] }))
      .toThrowError(NativeTranscriptConfigurationError);
    expect(() =>
      createNativeTranscriptScrubber({ pipelineVersion: "" }))
      .toThrowError(
        expect.objectContaining({ code: "invalid-input" }),
      );
    expect(() =>
      createNativeTranscriptScrubber({ pipelineVersion: "x\0y" }))
      .toThrowError(NativeTranscriptConfigurationError);
  });

  it("streams split CRLF/UTF-8 records, skips blanks, and stabilizes duplicate keys", async () => {
    const first = '{"b":"olá","a":1}\r\n';
    const second = '\n{"a":1,"b":"olá"}';
    const outcomes = await collect(
      byteChunks(
        Buffer.from(first).subarray(0, 7),
        Buffer.concat([
          Buffer.from(first).subarray(7),
          Buffer.from(second),
        ]),
      ),
    );
    expect(outcomes).toHaveLength(2);
    const records = outcomes.filter((outcome) => outcome.kind === "record");
    expect(records.map((record) => record.sourceOrdinal)).toEqual([0, 1]);
    expect(records[0]?.nativePayload).toEqual({ b: "olá", a: 1 });
    expect(records[0]?.contentSha256).toBe(records[1]?.contentSha256);
    expect(records[0]?.ingestKey).not.toBe(records[1]?.ingestKey);
    expect(records[1]?.endByteOffset).toBe(
      Buffer.byteLength(first + second),
    );
    expect(records[1]?.prefixSha256).toBe(digest(first + second));
  });

  it("quarantines malformed, scalar, NUL, binary, invalid UTF-8, and oversized records", async () => {
    const invalidUtf8 = Uint8Array.of(0xff, 0x0a);
    const outcomes = await collect(byteChunks(
      '{"bad":}\n',
      '42\n',
      '{"value":"\\u0000"}\n',
      Uint8Array.of(0x7b, 0x00, 0x7d, 0x0a),
      invalidUtf8,
      '{"long":"1234567890123',
      '4567890"}\n',
    ), { maxRecordBytes: 20 });
    expect(outcomes.map((outcome) =>
      outcome.kind === "quarantine" ? outcome.reason : "record"))
      .toEqual([
        "malformed-json",
        "non-container-json",
        "nul-character",
        "binary-input",
        "invalid-utf8",
        "record-too-large",
      ]);
    for (const outcome of outcomes) {
      expect(outcome.contentSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(JSON.stringify(outcome)).not.toContain("12345678901234567890");
    }
  });

  it("does not treat non-ASCII bytes as blank JSONL whitespace", async () => {
    const outcomes = await collect(byteChunks(
      Uint8Array.of(0xa0, 0x0a),
    ));
    expect(outcomes).toEqual([
      expect.objectContaining({
        kind: "quarantine",
        reason: "invalid-utf8",
        sourceOrdinal: 0,
      }),
    ]);
  });

  it("quarantines non-finite JSON numbers instead of hashing them as null", async () => {
    const outcomes = await collect(byteChunks(
      '{"value":1e400}\n{"value":null}\n',
    ));
    expect(outcomes[0]).toMatchObject({
      kind: "quarantine",
      reason: "malformed-json",
    });
    expect(outcomes[1]).toMatchObject({
      kind: "record",
      nativePayload: { value: null },
    });
    expect(outcomes[0]?.contentSha256).not.toBe(
      outcomes[1]?.contentSha256,
    );
  });

  it("bounds array, object, and mixed JSON nesting before recursive scrubbing", async () => {
    for (const kind of ["array", "object", "mixed"] as const) {
      const outcomes = await collect(byteChunks(
        `${nestedJson(NATIVE_TRANSCRIPT_MAX_JSON_DEPTH, kind)}\n`,
        `${nestedJson(NATIVE_TRANSCRIPT_MAX_JSON_DEPTH + 1, kind)}\n`,
      ));
      expect(outcomes[0]).toMatchObject({ kind: "record" });
      expect(outcomes[1]).toMatchObject({
        kind: "quarantine",
        reason: "nesting-too-deep",
      });
    }
  });

  it("rejects an invalid quarantine clock without leaking parser failures", async () => {
    await expect(collect(byteChunks('{"bad":}\n'), {
      clock: () => new Date(Number.NaN),
    })).rejects.toThrowError(NativeTranscriptConfigurationError);
  });

  it("quarantines redacted key collisions and residual scrub matches", async () => {
    const collision = await collect(byteChunks(
      '{"secret1":"a","secret2":"b"}\n',
    ), {
      scrubber: createNativeTranscriptScrubber({
        globalPatterns: ["secret[0-9]"],
      }),
    });
    expect(collision[0]).toMatchObject({
      kind: "quarantine",
      reason: "redacted-key-collision",
    });

    const residual = await collect(byteChunks('{"value":"secret"}\n'), {
      scrubber: createNativeTranscriptScrubber({
        globalPatterns: ["secret", "RED"],
      }),
    });
    expect(residual[0]).toMatchObject({
      kind: "quarantine",
      reason: "residual-secret",
    });

    const specialCollision = await collect(byteChunks(
      '{"__proto__":1,"secret":2}\n',
    ), {
      scrubber: createNativeTranscriptScrubber({
        globalPatterns: ["(?:__proto__|secret)"],
      }),
    });
    expect(specialCollision[0]).toMatchObject({
      kind: "quarantine",
      reason: "redacted-key-collision",
    });
  });

  it("preserves special JSON keys as safe own data properties", async () => {
    const outcomes = await collect(byteChunks(
      '{"__proto__":{"polluted":true},"constructor":"safe"}\n',
    ));
    const record = outcomes[0];
    expect(record?.kind).toBe("record");
    if (record?.kind !== "record") throw new Error("expected record");
    expect(Object.getPrototypeOf(record.nativePayload)).toBe(
      Object.prototype,
    );
    expect(Object.hasOwn(record.nativePayload, "__proto__")).toBe(true);
    expect(record.nativePayload).toEqual({
      ["__proto__"]: { polluted: true },
      constructor: "safe",
    });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects unsafe reader inputs without exposing record data", async () => {
    const base = {
      bytes: byteChunks("{}"),
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session",
      sourceLocator: "session.jsonl",
      scrubber: createNativeTranscriptScrubber(),
    };
    await expect(Array.fromAsync(readNativeTranscriptJsonl({
      ...base,
      sourceLocator: "../secret",
    }))).rejects.toThrowError(NativeTranscriptConfigurationError);
    await expect(Array.fromAsync(readNativeTranscriptJsonl({
      ...base,
      sourceLocator: "C:\\secret",
    }))).rejects.toThrowError(NativeTranscriptConfigurationError);
    await expect(Array.fromAsync(readNativeTranscriptJsonl({
      ...base,
      nativeSessionId: "",
    }))).rejects.toThrowError(NativeTranscriptConfigurationError);
    await expect(Array.fromAsync(readNativeTranscriptJsonl({
      ...base,
      maxRecordBytes: 0,
    }))).rejects.toThrowError(NativeTranscriptConfigurationError);
    await expect(Array.fromAsync(readNativeTranscriptJsonl({
      ...base,
      clock: () => new Date(Number.NaN),
    }))).rejects.toThrowError(NativeTranscriptConfigurationError);
    await expect(Array.fromAsync(readNativeTranscriptJsonl({
      ...base,
      format: {
        clientName: "claude-code",
        formatName: "codex-jsonl",
        formatVersion: "v1",
      } as typeof CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
    }))).rejects.toThrowError(NativeTranscriptConfigurationError);
    const invalidBytes = (async function* (): AsyncGenerator<Uint8Array> {
      yield "not bytes" as unknown as Uint8Array;
    })();
    await expect(Array.fromAsync(readNativeTranscriptJsonl({
      ...base,
      bytes: invalidBytes,
    }))).rejects.toThrowError(NativeTranscriptConfigurationError);
  });

  it("maps sanitized Claude and Codex message shapes with runtime role checks", () => {
    const claude = createNativeTranscriptMessageMapper();
    expect(claude.map(CLAUDE_NATIVE_TRANSCRIPT_FORMAT, {
      message: {
        role: "user",
        content: [
          { type: "text", text: "one" },
          {
            type: "tool_result",
            content: [{ type: "text", text: "two" }],
          },
        ],
      },
    }, 9)).toEqual([{
      sessionSequence: 0,
      role: "user",
      content: "one\ntwo",
      sourceOrdinal: 0,
    }]);
    expect(claude.map(CLAUDE_NATIVE_TRANSCRIPT_FORMAT, {
      message: { role: "developer", content: "ignored" },
    }, 10)).toEqual([]);
    expect(claude.map(CLAUDE_NATIVE_TRANSCRIPT_FORMAT, [], 10)).toEqual([]);
    expect(claude.map(CLAUDE_NATIVE_TRANSCRIPT_FORMAT, {
      message: {
        role: "assistant",
        content: [42, { type: "ignored" }],
      },
    }, 10)).toEqual([]);
    expect(claude.map(CLAUDE_NATIVE_TRANSCRIPT_FORMAT, {
      message: { role: "assistant", content: {} },
    }, 10)).toEqual([]);
    expect(claude.map(CLAUDE_NATIVE_TRANSCRIPT_FORMAT, {
      message: { role: "system", content: "system" },
    }, 11)[0]).toMatchObject({
      sessionSequence: 1,
      role: "system",
      content: "system",
    });

    const codex = createNativeTranscriptMessageMapper();
    expect(codex.map(CODEX_NATIVE_TRANSCRIPT_FORMAT, {
      type: "event_msg",
      payload: {},
    }, 0)).toEqual([]);
    expect(codex.map(CODEX_NATIVE_TRANSCRIPT_FORMAT, {
      type: "response_item",
      payload: { type: "tool_call" },
    }, 1)).toEqual([]);
    expect(codex.map(CODEX_NATIVE_TRANSCRIPT_FORMAT, {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: " direct ",
      },
    }, 1)[0]).toMatchObject({
      sessionSequence: 0,
      role: "user",
      content: "direct",
    });
    expect(codex.map(CODEX_NATIVE_TRANSCRIPT_FORMAT, {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: {},
      },
    }, 1)).toEqual([]);
    expect(codex.map(CODEX_NATIVE_TRANSCRIPT_FORMAT, {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: " answer " },
          { type: "ignored", text: "secret" },
        ],
      },
    }, 1)).toEqual([{
      sessionSequence: 1,
      role: "assistant",
      content: "answer",
      sourceOrdinal: 0,
    }]);
    expect(codex.map(CODEX_NATIVE_TRANSCRIPT_FORMAT, {
      type: "response_item",
      payload: {
        type: "message",
        role: "tool",
        content: "ignored",
      },
    }, 2)).toEqual([]);
  });
});

describe("filesystem native transcript source", () => {
  it("streams a descriptor-bound regular file and hashes bounded prefixes", async () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, "sessions"));
    const content = '{"one":1}\n{"two":2}\n';
    writeFileSync(join(root, "sessions", "s.jsonl"), content);
    const byteSource = createFileNativeTranscriptSource(
      root,
      "sessions/s.jsonl",
      { chunkBytes: 3 },
    );
    const snapshot = await byteSource.openSnapshot();
    const metadata = snapshot.metadata;
    expect(metadata.sizeBytes).toBe(Buffer.byteLength(content));
    expect(metadata.modifiedAtMs).toBeGreaterThan(0);
    expect(metadata.changedAtMs).toBeGreaterThan(0);
    const chunks = await Array.fromAsync(snapshot.stream());
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(content));
    expect(await snapshot.digestPrefix(10)).toBe(
      digest(Buffer.from(content).subarray(0, 10)),
    );
    expect(await snapshot.digestPrefix(0)).toBe(digest(""));
    await expect(snapshot.digestPrefix(metadata.sizeBytes + 1))
      .rejects.toThrowError(NativeTranscriptConfigurationError);
    await snapshot.assertUnchanged();
    await snapshot.close();
    await snapshot.close();
    await expect(snapshot.assertUnchanged()).rejects.toThrowError(
      NativeTranscriptConfigurationError,
    );

    const fromFilesystemRoot = createFileNativeTranscriptSource(
      "/",
      join(root.slice(1), "sessions", "s.jsonl"),
    );
    const rootSnapshot = await fromFilesystemRoot.openSnapshot();
    expect(rootSnapshot.metadata.sizeBytes).toBe(Buffer.byteLength(content));
    await rootSnapshot.close();
  });

  it("rejects unsafe locators, chunk sizes, symlinks, and non-files", async () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, "sessions"));
    writeFileSync(join(root, "target.jsonl"), "{}\n");
    symlinkSync(
      join(root, "target.jsonl"),
      join(root, "sessions", "link.jsonl"),
    );
    expect(() => createFileNativeTranscriptSource(root, "../outside"))
      .toThrowError(NativeTranscriptConfigurationError);
    expect(() => createFileNativeTranscriptSource(
      root,
      "target.jsonl",
      { chunkBytes: 0 },
    )).toThrowError(NativeTranscriptConfigurationError);
    const link = createFileNativeTranscriptSource(
      root,
      "sessions/link.jsonl",
    );
    await expect(link.openSnapshot()).rejects.toThrow();
    const directory = createFileNativeTranscriptSource(root, "sessions");
    await expect(directory.openSnapshot()).rejects.toThrowError(
      NativeTranscriptConfigurationError,
    );

    const outside = temporaryDirectory();
    mkdirSync(join(outside, "nested"));
    writeFileSync(join(outside, "nested", "outside.jsonl"), "{}\n");
    symlinkSync(join(outside, "nested"), join(root, "escaped"));
    const escaped = createFileNativeTranscriptSource(
      root,
      "escaped/outside.jsonl",
    );
    await expect(escaped.openSnapshot()).rejects.toThrowError(
      NativeTranscriptConfigurationError,
    );
  });

  it("detects descriptor replacement and shrink races", async () => {
    const root = temporaryDirectory();
    const path = join(root, "source.jsonl");
    const moved = join(root, "moved.jsonl");
    writeFileSync(path, "{}\n");
    let replaced = false;
    const replacement = createFileNativeTranscriptSource(
      `${root}/`,
      "source.jsonl",
      {
        _afterOpenForTesting: () => {
          if (replaced) return;
          replaced = true;
          renameSync(path, moved);
          writeFileSync(path, '{"replacement":true}\n');
        },
      },
    );
    await expect(replacement.openSnapshot()).rejects.toThrowError(
      NativeTranscriptConfigurationError,
    );
    const failedHook = createFileNativeTranscriptSource(
      root,
      "source.jsonl",
      {
        _afterSnapshotOpenForTesting: () => {
          throw new Error("snapshot hook failed");
        },
      },
    );
    await expect(failedHook.openSnapshot()).rejects.toThrow(
      "snapshot hook failed",
    );

    writeFileSync(path, '{"long":true}\n');
    let truncated = false;
    const shrinking = createFileNativeTranscriptSource(
      root,
      "source.jsonl",
      {
        _afterOpenForTesting: () => {
          if (truncated) return;
          truncated = true;
          truncateSync(path, 0);
        },
      },
    );
    const shrinkingSnapshot = await shrinking.openSnapshot();
    await expect(shrinkingSnapshot.digestPrefix(5)).rejects.toThrowError(
      NativeTranscriptSourceChangedError,
    );
    await shrinkingSnapshot.close();
  });

  it("keeps an atomic path replacement bound to the opened inode", async () => {
    const root = temporaryDirectory();
    const path = join(root, "source.jsonl");
    const moved = join(root, "original.jsonl");
    const original = '{"value":"original"}\n';
    writeFileSync(path, original);
    const repo = repository();
    await runNativeTranscriptBackfill({
      repository: repo,
      quarantine: {
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: createFileNativeTranscriptSource(root, "source.jsonl", {
        _afterSnapshotOpenForTesting: () => {
          renameSync(path, moved);
          writeFileSync(path, '{"value":"replacement"}\n');
        },
      }),
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "source.jsonl",
      messageResolver: { resolveExact: vi.fn(async () => null) },
    });
    expect(repo.batches).toHaveLength(1);
    expect(repo.batches[0]?.records[0]?.nativePayload).toEqual({
      value: "original",
    });
    expect(repo.batches[0]?.checkpoint.checkpoint).toMatchObject({
      byteOffset: Buffer.byteLength(original),
      prefixSha256: digest(original),
    });
  });

  it("fails closed on rewrite, append, and truncate races before destination access", async () => {
    const root = temporaryDirectory();
    const path = join(root, "source.jsonl");
    const first = '{"value":"one"}\n';
    const second = '{"value":"two"}\n';

    writeFileSync(path, first + second);
    const prefixRepo = repository(checkpoint({
      version: 1,
      byteOffset: Buffer.byteLength(first),
      prefixSha256: digest(first),
      source: {
        sizeBytes: Buffer.byteLength(first),
        modifiedAtMs: 1,
        changedAtMs: 1,
      },
    }));
    await expect(runNativeTranscriptBackfill({
      repository: prefixRepo,
      quarantine: {
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: createFileNativeTranscriptSource(root, "source.jsonl", {
        _beforeDigestPrefixForTesting: () => {
          writeFileSync(path, '{"value":"eno"}\n' + second);
        },
      }),
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "source.jsonl",
      messageResolver: { resolveExact: vi.fn(async () => null) },
    })).rejects.toThrowError(NativeTranscriptSourceChangedError);
    expect(prefixRepo.batches).toEqual([]);

    writeFileSync(path, first);
    const appendRepo = repository();
    await expect(runNativeTranscriptBackfill({
      repository: appendRepo,
      quarantine: {
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: createFileNativeTranscriptSource(root, "source.jsonl", {
        _beforeStreamForTesting: () => {
          writeFileSync(path, second, { flag: "a" });
        },
      }),
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "source.jsonl",
      messageResolver: { resolveExact: vi.fn(async () => null) },
    })).rejects.toThrowError(NativeTranscriptSourceChangedError);
    expect(appendRepo.batches).toEqual([]);

    writeFileSync(path, first + second);
    const truncateRepo = repository();
    await expect(runNativeTranscriptBackfill({
      repository: truncateRepo,
      quarantine: {
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: createFileNativeTranscriptSource(root, "source.jsonl", {
        chunkBytes: 2,
        _afterChunkForTesting: (ordinal) => {
          if (ordinal === 0) truncateSync(path, 0);
        },
      }),
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "source.jsonl",
      messageResolver: { resolveExact: vi.fn(async () => null) },
    })).rejects.toThrowError(NativeTranscriptSourceChangedError);
    expect(truncateRepo.batches).toEqual([]);

    writeFileSync(path, first + second);
    const rewriteRepo = repository();
    await expect(runNativeTranscriptBackfill({
      repository: rewriteRepo,
      quarantine: {
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: createFileNativeTranscriptSource(root, "source.jsonl", {
        chunkBytes: Buffer.byteLength(first),
        _afterChunkForTesting: (ordinal) => {
          if (ordinal === 0) writeFileSync(path, second + first);
        },
      }),
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "source.jsonl",
      messageResolver: { resolveExact: vi.fn(async () => null) },
    })).rejects.toThrowError(NativeTranscriptSourceChangedError);
    expect(rewriteRepo.batches).toEqual([]);

    const fixedTime = new Date("2026-07-25T12:00:00.000Z");
    writeFileSync(path, first + second);
    utimesSync(path, fixedTime, fixedTime);
    const restoredMtimeRepo = repository();
    await expect(runNativeTranscriptBackfill({
      repository: restoredMtimeRepo,
      quarantine: {
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: createFileNativeTranscriptSource(root, "source.jsonl", {
        _beforeStreamForTesting: () => {
          writeFileSync(path, second + first);
          utimesSync(path, fixedTime, fixedTime);
        },
      }),
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "source.jsonl",
      messageResolver: { resolveExact: vi.fn(async () => null) },
    })).rejects.toThrowError(NativeTranscriptSourceChangedError);
    expect(restoredMtimeRepo.batches).toEqual([]);

    writeFileSync(path, first);
    const missingLocatorRepo = repository();
    await expect(runNativeTranscriptBackfill({
      repository: missingLocatorRepo,
      quarantine: {
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: createFileNativeTranscriptSource(root, "source.jsonl", {
        _beforeStreamForTesting: () => {
          renameSync(path, join(root, "detached.jsonl"));
        },
      }),
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "source.jsonl",
      messageResolver: { resolveExact: vi.fn(async () => null) },
    })).rejects.toThrowError(NativeTranscriptSourceChangedError);
    expect(missingLocatorRepo.batches).toEqual([]);
  });
});

describe("exact native transcript message resolver", () => {
  it("resolves exact messages across every conversation in session-wide order", async () => {
    const olderConversation = {
      conversationId: 7,
      sessionId: "session-1",
      title: null,
      bootstrappedAt: null,
      createdAt: new Date("2026-07-24T12:00:00.000Z"),
      updatedAt: new Date("2026-07-24T12:00:00.000Z"),
    };
    const newerConversation = {
      ...olderConversation,
      conversationId: 4,
      createdAt: new Date("2026-07-25T12:00:00.000Z"),
      updatedAt: new Date("2026-07-25T12:00:00.000Z"),
    };
    const unrelatedConversation = {
      ...olderConversation,
      conversationId: 8,
      sessionId: "other-session",
    };
    const olderMessage = {
      messageId: 9,
      conversationId: 7,
      seq: 0,
      role: "user" as const,
      content: "question",
      tokenCount: 1,
      createdAt: new Date(),
    };
    const newerMessage = {
      messageId: 10,
      conversationId: 4,
      seq: 0,
      role: "assistant" as const,
      content: "scrubbed",
      tokenCount: 2,
      createdAt: new Date(),
    };
    const listConversations = vi.fn(async () => [
      newerConversation,
      unrelatedConversation,
      olderConversation,
    ]);
    const getMessages = vi.fn(async (conversationId: number) =>
      conversationId === 7 ? [olderMessage] : [newerMessage]
    );
    const resolver = createExactNativeTranscriptMessageResolver({
      listConversations,
      getMessages,
    } as unknown as ConversationRepository);
    const input = {
      nativeSessionId: "session-1",
      sessionSequence: 1,
      role: "assistant" as const,
      content: "scrubbed",
    };
    await expect(resolver.resolveExact(input)).resolves.toEqual({
      conversationId: 4,
      messageId: 10,
    });
    expect(getMessages.mock.calls).toEqual([[7], [4]]);

    olderMessage.content = "repository-mutated";
    newerMessage.content = "repository-mutated";
    await expect(resolver.resolveExact({
      ...input,
      sessionSequence: 0,
      role: "user",
      content: "question",
    })).resolves.toEqual({ conversationId: 7, messageId: 9 });
    await expect(resolver.resolveExact({
      ...input,
      content: "different",
    })).resolves.toBeNull();
    expect(listConversations).toHaveBeenCalledTimes(1);
    expect(getMessages).toHaveBeenCalledTimes(2);

    const emptyResolver = createExactNativeTranscriptMessageResolver({
      listConversations: vi.fn(async () => [unrelatedConversation]),
    } as unknown as ConversationRepository);
    await expect(emptyResolver.resolveExact(input)).resolves.toBeNull();
  });

  it("breaks conversation timestamp ties by ID and rejects inconsistent data", async () => {
    const createdAt = new Date("2026-07-25T12:00:00.000Z");
    const conversation = (conversationId: number) => ({
      conversationId,
      sessionId: "session-1",
      title: null,
      bootstrappedAt: null,
      createdAt,
      updatedAt: createdAt,
    });
    const message = (conversationId: number, messageId: number, seq = 0) => ({
      messageId,
      conversationId,
      seq,
      role: "user" as const,
      content: `message-${messageId}`,
      tokenCount: 1,
      createdAt,
    });
    const input = {
      nativeSessionId: "session-1",
      sessionSequence: 0,
      role: "user" as const,
      content: "message-1",
    };
    const resolveWith = (
      listed: ReturnType<typeof conversation>[],
      messages: ReturnType<typeof message>[],
    ) => createExactNativeTranscriptMessageResolver({
      listConversations: vi.fn(async () => listed),
      getMessages: vi.fn(async (conversationId: number) =>
        messages.filter((entry) => entry.conversationId === conversationId)
      ),
    } as unknown as ConversationRepository).resolveExact(input);

    await expect(resolveWith(
      [conversation(2), conversation(1)],
      [message(2, 2), message(1, 1)],
    )).resolves.toEqual({ conversationId: 1, messageId: 1 });
    await expect(resolveWith(
      [conversation(1), conversation(1)],
      [message(1, 1)],
    )).resolves.toBeNull();
    await expect(resolveWith([{
      ...conversation(1),
      createdAt: new Date(Number.NaN),
    }], [message(1, 1)])).resolves.toBeNull();
    await expect(resolveWith(
      [conversation(1)],
      [message(2, 1)],
    )).resolves.toBeNull();
    await expect(resolveWith(
      [conversation(1)],
      [message(1, 1, 1)],
    )).resolves.toBeNull();
  });

  it("rejects invalid resolver inputs before conversation access", async () => {
    const listConversations = vi.fn();
    const resolver = createExactNativeTranscriptMessageResolver({
      listConversations,
    } as unknown as ConversationRepository);
    const invalidInputs = [
      { sessionSequence: -1 },
      { sessionSequence: 0.5 },
      { role: "developer" },
      { nativeSessionId: "" },
      { nativeSessionId: "bad\0session" },
      { content: "bad\0content" },
    ];
    for (const override of invalidInputs) {
      await expect(resolver.resolveExact({
        nativeSessionId: "session",
        sessionSequence: 0,
        role: "user",
        content: "content",
        ...override,
      } as never)).resolves.toBeNull();
    }
    expect(listConversations).not.toHaveBeenCalled();
  });
});

describe("native transcript backfill coordinator", () => {
  it("validates scrubbers before touching source or destination", async () => {
    const repo = repository();
    const byteSource = source("{}\n");
    await expect(runNativeTranscriptBackfill({
      repository: repo,
      quarantine: {
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: byteSource,
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "sessions/session.jsonl",
      globalPatterns: ["["],
      messageResolver: { resolveExact: vi.fn(async () => null) },
    })).rejects.toMatchObject({ code: "invalid-patterns" });
    expect(byteSource.openSnapshot).not.toHaveBeenCalled();
    expect(repo.getCheckpoint).not.toHaveBeenCalled();
  });

  it("batches valid records, exact links, and metadata-only quarantines", async () => {
    const repo = repository();
    const quarantined = vi.fn(async (input) => ({
      quarantineId: 1,
      ...input,
    }));
    const content = [
      '{"message":"canary_123"}',
      '{"event":"non-message"}',
      '{"bad":}',
    ].join("\n");
    const result = await runNativeTranscriptBackfill({
      repository: repo,
      quarantine: {
        quarantine: quarantined,
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: source(content),
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "sessions/session.jsonl",
      globalPatterns: ["canary_[0-9]+"],
      batchSize: 2,
      clock: () => new Date("2026-07-25T12:00:00.000Z"),
      messageMapper: {
        map: (_format, payload, sourceOrdinal) =>
          sourceOrdinal === 0
            ? [{
                sessionSequence: 7,
                role: "user",
                content: (payload as JsonObject).message as string,
                sourceOrdinal: 0,
              }]
            : [],
      },
      messageResolver: {
        resolveExact: vi.fn(async (input) => {
          expect(input).toEqual({
            nativeSessionId: "session-1",
            sessionSequence: 7,
            role: "user",
            content: "[REDACTED]",
          });
          return { conversationId: 4, messageId: 9 };
        }),
      },
    });
    expect(result).toEqual({
      importedCount: 2,
      skippedCount: 0,
      quarantinedCount: 1,
      resumedFromByteOffset: 0,
      rescanned: false,
    });
    expect(repo.batches).toHaveLength(2);
    expect(repo.batches[0]?.expectedCheckpoint).toBeNull();
    expect(repo.batches[1]?.expectedCheckpoint).toEqual(
      expect.objectContaining({
        checkpoint: repo.batches[0]?.checkpoint.checkpoint,
      }),
    );
    expect(repo.batches[0]?.records[0]?.messageLinks).toEqual([{
      conversationId: 4,
      messageId: 9,
      sourceOrdinal: 0,
    }]);
    expect(repo.batches[0]?.records[1]?.messageLinks).toEqual([]);
    expect(repo.batches[1]).toMatchObject({
      records: [],
      quarantinedCount: 1,
      checkpoint: { lastSourceOrdinal: 2 },
    });
    expect(repo.batches[1]?.checkpoint.checkpoint).toMatchObject({
      version: 1,
      byteOffset: Buffer.byteLength(content),
      prefixSha256: digest(content),
      source: {
        sizeBytes: Buffer.byteLength(content),
        modifiedAtMs: 123,
        changedAtMs: 456,
      },
    });
    expect(quarantined).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceLocator: "sessions/session.jsonl",
        sourceOrdinal: 2,
        reason: "malformed-json",
      }),
    );
    expect(JSON.stringify(quarantined.mock.calls)).not.toContain('{"bad":}');
  });

  it("quarantines over-depth input locally before an empty-record checkpoint batch", async () => {
    const events: string[] = [];
    const repo = repository();
    vi.mocked(repo.ingestBatch).mockImplementationOnce(async (input) => {
      events.push("repository");
      repo.batches.push(input);
      return {
        importedCount: 0,
        skippedCount: 0,
        quarantinedCount: input.quarantinedCount,
        checkpoint: checkpoint(input.checkpoint.checkpoint),
      };
    });
    const quarantine = vi.fn(async (input) => {
      events.push("quarantine");
      return {
        quarantineId: 1,
        ...input,
      };
    });
    await runNativeTranscriptBackfill({
      repository: repo,
      quarantine: {
        quarantine,
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: source(
        `${nestedJson(NATIVE_TRANSCRIPT_MAX_JSON_DEPTH + 1, "mixed")}\n`,
      ),
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "sessions/session.jsonl",
      messageResolver: { resolveExact: vi.fn(async () => null) },
    });
    expect(events).toEqual(["quarantine", "repository"]);
    expect(repo.batches).toHaveLength(1);
    expect(repo.batches[0]).toMatchObject({
      records: [],
      quarantinedCount: 1,
    });
    expect(quarantine).toHaveBeenCalledWith(expect.objectContaining({
      reason: "nesting-too-deep",
    }));
    expect(JSON.stringify(repo.batches)).not.toContain('"value"');
  });

  it("resumes an unchanged prefix and rescans a changed prefix idempotently", async () => {
    const content = '{"first":1}\n{"second":2}\n';
    const firstLineBytes = Buffer.byteLength('{"first":1}\n');
    const unchanged = repository(checkpoint({
      version: 1,
      byteOffset: firstLineBytes,
      prefixSha256: digest('{"first":1}\n'),
      source: {
        sizeBytes: firstLineBytes,
        modifiedAtMs: 1,
        changedAtMs: 1,
      },
    }));
    const options = {
      quarantine: {
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: source(content),
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "sessions/session.jsonl",
      messageResolver: { resolveExact: vi.fn(async () => null) },
    };
    const resumed = await runNativeTranscriptBackfill({
      ...options,
      repository: unchanged,
    });
    expect(resumed.resumedFromByteOffset).toBe(firstLineBytes);
    expect(resumed.rescanned).toBe(false);
    expect(unchanged.batches[0]?.records).toHaveLength(1);
    expect(unchanged.batches[0]?.records[0]?.sourceOrdinal).toBe(1);
    expect(unchanged.batches[0]?.expectedCheckpoint).toEqual(
      expect.objectContaining({
        checkpoint: {
          version: 1,
          byteOffset: firstLineBytes,
          prefixSha256: digest('{"first":1}\n'),
          source: {
            sizeBytes: firstLineBytes,
            modifiedAtMs: 1,
            changedAtMs: 1,
          },
        },
      }),
    );

    const changed = repository(checkpoint({
      version: 1,
      byteOffset: firstLineBytes,
      prefixSha256: "0".repeat(64),
      source: {
        sizeBytes: firstLineBytes,
        modifiedAtMs: 1,
        changedAtMs: 1,
      },
    }));
    const rescanned = await runNativeTranscriptBackfill({
      ...options,
      repository: changed,
    });
    expect(rescanned.resumedFromByteOffset).toBe(0);
    expect(rescanned.rescanned).toBe(true);
    expect(changed.batches[0]?.records).toHaveLength(2);

    const malformedCheckpoint = repository(checkpoint({}));
    const malformed = await runNativeTranscriptBackfill({
      ...options,
      repository: malformedCheckpoint,
    });
    expect(malformed.rescanned).toBe(true);
    expect(malformedCheckpoint.batches[0]?.records).toHaveLength(2);
  });

  it("replays prefix messages through the mapper without resolving or rewriting them", async () => {
    const firstLine =
      '{"message":{"role":"user","content":"first"}}\n';
    const secondLine =
      '{"message":{"role":"assistant","content":"second"}}\n';
    const previous = checkpoint({
      version: 1,
      byteOffset: Buffer.byteLength(firstLine),
      prefixSha256: digest(firstLine),
      source: {
        sizeBytes: Buffer.byteLength(firstLine),
        modifiedAtMs: 1,
        changedAtMs: 1,
      },
    });
    const repo = repository(previous);
    const resolveExact = vi.fn(async () => ({
      conversationId: 4,
      messageId: 9,
    }));
    await runNativeTranscriptBackfill({
      repository: repo,
      quarantine: {
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: source(firstLine + secondLine),
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "sessions/session.jsonl",
      messageResolver: { resolveExact },
    });
    expect(resolveExact).toHaveBeenCalledTimes(1);
    expect(resolveExact).toHaveBeenCalledWith({
      nativeSessionId: "session-1",
      sessionSequence: 1,
      role: "assistant",
      content: "second",
    });
    expect(repo.batches[0]?.records).toHaveLength(1);
    expect(repo.batches[0]?.expectedCheckpoint).toBe(previous);

    const quarantinedPrefix = '{"bad":}\n';
    const quarantinedPrevious = checkpoint({
      version: 1,
      byteOffset: Buffer.byteLength(quarantinedPrefix),
      prefixSha256: digest(quarantinedPrefix),
      source: {
        sizeBytes: Buffer.byteLength(quarantinedPrefix),
        modifiedAtMs: 1,
        changedAtMs: 1,
      },
    });
    const quarantinedRepo = repository(quarantinedPrevious);
    const quarantine = vi.fn();
    await runNativeTranscriptBackfill({
      repository: quarantinedRepo,
      quarantine: {
        quarantine,
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: source(`${quarantinedPrefix}{"event":"appended"}\n`),
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "sessions/session.jsonl",
      messageResolver: { resolveExact: vi.fn(async () => null) },
    });
    expect(quarantine).not.toHaveBeenCalled();
    expect(quarantinedRepo.batches[0]?.records).toHaveLength(1);
  });

  it("isolates the immutable repository payload from a malicious mapper", async () => {
    const repo = repository();
    await runNativeTranscriptBackfill({
      repository: repo,
      quarantine: {
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: source('{"safe":{"nested":"value"},"list":[1]}\n'),
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "sessions/session.jsonl",
      messageMapper: {
        map: (_format, payload) => {
          const mutable = payload as {
            safe: { nested: string };
            list: number[];
            injected?: string;
          };
          mutable.safe.nested = "mutated";
          mutable.list.push(2);
          mutable.injected = "canary_secret";
          return [];
        },
      },
      messageResolver: { resolveExact: vi.fn(async () => null) },
    });
    const stored = repo.batches[0]?.records[0];
    expect(stored?.nativePayload).toEqual({
      safe: { nested: "value" },
      list: [1],
    });
    expect(stored?.contentSha256).toBe(digest(
      canonicalNativeTranscriptJson(stored!.nativePayload),
    ));
    expect(JSON.stringify(stored?.nativePayload)).not.toContain(
      "canary_secret",
    );
  });

  it("checkpoints blank-only consumed bytes outside record accounting", async () => {
    const repo = repository();
    const content = "\n  \r\n";
    const result = await runNativeTranscriptBackfill({
      repository: repo,
      quarantine: {
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: source(content),
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "sessions/session.jsonl",
      messageResolver: { resolveExact: vi.fn(async () => null) },
    });
    expect(result).toEqual({
      importedCount: 0,
      skippedCount: 0,
      quarantinedCount: 0,
      resumedFromByteOffset: 0,
      rescanned: false,
    });
    expect(repo.batches).toHaveLength(1);
    expect(repo.batches[0]).toMatchObject({
      records: [],
      quarantinedCount: 0,
      checkpoint: {
        lastSourceOrdinal: 0,
        checkpoint: {
          byteOffset: Buffer.byteLength(content),
          prefixSha256: digest(content),
        },
      },
    });
  });

  it("aborts exact-link mismatches without committing the batch", async () => {
    const repo = repository();
    await expect(runNativeTranscriptBackfill({
      repository: repo,
      quarantine: {
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: source('{"message":"hello"}\n'),
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "sessions/session.jsonl",
      messageMapper: {
        map: () => [{
          sessionSequence: 0,
          role: "assistant",
          content: "hello",
          sourceOrdinal: 0,
        }],
      },
      messageResolver: { resolveExact: vi.fn(async () => null) },
    })).rejects.toBeInstanceOf(NativeTranscriptLinkError);
    expect(repo.ingestBatch).not.toHaveBeenCalled();
  });

  it("rejects unsafe mapped message metadata before resolution", async () => {
    const repo = repository();
    const base = {
      repository: repo,
      quarantine: {
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: source('{"message":"hello"}\n'),
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "sessions/session.jsonl",
      messageResolver: { resolveExact: vi.fn(async () => ({
        conversationId: 1,
        messageId: 1,
      })) },
    };
    await expect(runNativeTranscriptBackfill({
      ...base,
      messageMapper: {
        map: () => [{
          sessionSequence: 0,
          role: "user",
          content: "bad\0content",
          sourceOrdinal: 0,
        }],
      },
    })).rejects.toThrowError(NativeTranscriptConfigurationError);
    await expect(runNativeTranscriptBackfill({
      ...base,
      messageMapper: {
        map: () => [{
          sessionSequence: -1,
          role: "user",
          content: "content",
          sourceOrdinal: 0,
        }],
      },
    })).rejects.toThrowError(NativeTranscriptConfigurationError);
    await expect(runNativeTranscriptBackfill({
      ...base,
      messageMapper: {
        map: () => [{
          sessionSequence: 0,
          role: "developer" as never,
          content: "content",
          sourceOrdinal: 0,
        }],
      },
    })).rejects.toThrowError(NativeTranscriptConfigurationError);
  });

  it("rejects incomplete mapping, unsafe batch, and invalid metadata", async () => {
    const repo = repository();
    const base = {
      repository: repo,
      quarantine: {
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: source("{}\n"),
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "sessions/session.jsonl",
    };
    await expect(runNativeTranscriptBackfill({
      ...base,
      messageMapper: { map: () => [] },
    })).rejects.toThrowError(NativeTranscriptConfigurationError);
    await expect(runNativeTranscriptBackfill({
      ...base,
      batchSize: 1_001,
      messageResolver: { resolveExact: vi.fn(async () => null) },
    })).rejects.toThrowError(NativeTranscriptConfigurationError);
    await expect(runNativeTranscriptBackfill({
      ...base,
      messageResolver: { resolveExact: vi.fn(async () => null) },
      source: {
        openSnapshot: async () => {
          const snapshot = await source("{}\n").openSnapshot();
          return {
            ...snapshot,
            metadata: {
              sizeBytes: -1,
              modifiedAtMs: 0,
              changedAtMs: 0,
            },
          };
        },
      },
    })).rejects.toThrowError(NativeTranscriptConfigurationError);
    await expect(runNativeTranscriptBackfill({
      ...base,
      messageResolver: { resolveExact: vi.fn(async () => null) },
      source: {
        openSnapshot: async () => {
          const snapshot = await source("{}\n").openSnapshot();
          return {
            ...snapshot,
            metadata: {
              sizeBytes: 3,
              modifiedAtMs: -1,
              changedAtMs: 0,
            },
          };
        },
      },
    })).rejects.toThrowError(NativeTranscriptConfigurationError);
    await expect(runNativeTranscriptBackfill({
      ...base,
      messageResolver: { resolveExact: vi.fn(async () => null) },
      source: {
        openSnapshot: async () => {
          const snapshot = await source("{}\n").openSnapshot();
          return {
            ...snapshot,
            metadata: {
              sizeBytes: 3,
              modifiedAtMs: 0,
              changedAtMs: -1,
            },
          };
        },
      },
    })).rejects.toThrowError(NativeTranscriptConfigurationError);
  });
});

describe("local transcript quarantine", () => {
  it("uses an opaque private per-project database and idempotent list/get APIs", async () => {
    const home = temporaryDirectory();
    const path = localTranscriptQuarantinePath("project/a", home);
    expect(path).not.toContain("project/a");
    const repo = openLocalTranscriptQuarantine("project/a", home);
    const input = {
      sourceLocator: "sessions/session.jsonl",
      sourceOrdinal: 4,
      reason: "malformed-json" as const,
      contentSha256: "a".repeat(64),
      quarantinedAt: new Date("2026-07-25T12:00:00.000Z"),
    };
    const first = await repo.quarantine(input);
    const repeated = await repo.quarantine({
      ...input,
      quarantinedAt: new Date("2026-07-25T13:00:00.000Z"),
    });
    await repo.quarantine({
      ...input,
      sourceOrdinal: 5,
      reason: "binary-input",
      contentSha256: "b".repeat(64),
    });
    expect(repeated).toEqual(first);
    expect(await repo.get(first.quarantineId)).toEqual(first);
    expect(await repo.get(0)).toBeNull();
    expect(await repo.get(99)).toBeNull();
    expect(await repo.list({ reason: "malformed-json", limit: 1 }))
      .toEqual([first]);
    expect(await repo.list()).toHaveLength(2);
    expect(statSync(join(home, ".lcm", "transcript-quarantine")).mode & 0o777)
      .toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(lstatSync(path).isFile()).toBe(true);
    await repo.close();
    await repo.close();
    await expect(repo.list()).rejects.toMatchObject({
      code: "STORAGE_CLOSED",
    });
  });

  it("rejects invalid metadata, limits, closed access, and symlink leaves", async () => {
    const home = temporaryDirectory();
    const repo = openLocalTranscriptQuarantine("project", home);
    const base = {
      sourceLocator: "source",
      sourceOrdinal: 0,
      reason: TRANSCRIPT_QUARANTINE_REASONS[0],
      contentSha256: "c".repeat(64),
      quarantinedAt: new Date(),
    };
    await expect(repo.quarantine({
      ...base,
      sourceLocator: "",
    })).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    await expect(repo.quarantine({
      ...base,
      sourceOrdinal: -1,
    })).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    await expect(repo.quarantine({
      ...base,
      reason: "unknown" as typeof base.reason,
    })).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    await expect(repo.quarantine({
      ...base,
      contentSha256: "bad",
    })).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    await expect(repo.quarantine({
      ...base,
      quarantinedAt: new Date(Number.NaN),
    })).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    await expect(repo.get(-1)).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
    });
    await expect(repo.list({ limit: 0 })).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
    });
    await expect(repo.list({ limit: 1_001 })).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
    });
    await repo.close();
    const path = localTranscriptQuarantinePath("symlink", home);
    symlinkSync("/dev/null", path);
    expect(() => openLocalTranscriptQuarantine("symlink", home))
      .toThrow("symlink");
  });

  it("migrates the unreleased quarantine schema without losing metadata", async () => {
    const home = temporaryDirectory();
    const path = localTranscriptQuarantinePath("legacy-project", home);
    mkdirSync(dirname(path), { recursive: true });
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE transcript_quarantine (
        quarantine_id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_locator TEXT NOT NULL,
        source_ordinal INTEGER NOT NULL CHECK (source_ordinal >= 0),
        reason TEXT NOT NULL CHECK (reason IN (
          'malformed-json',
          'non-container-json',
          'invalid-utf8',
          'binary-input',
          'nul-character',
          'record-too-large',
          'redacted-key-collision',
          'residual-secret'
        )),
        content_sha256 TEXT NOT NULL CHECK (
          length(content_sha256) = 64
          AND content_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        quarantined_at TEXT NOT NULL,
        UNIQUE (source_locator, source_ordinal, content_sha256)
      )
    `);
    legacy.prepare(`
      INSERT INTO transcript_quarantine (
        source_locator,
        source_ordinal,
        reason,
        content_sha256,
        quarantined_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      "legacy.jsonl",
      1,
      "malformed-json",
      "a".repeat(64),
      "2026-07-25T12:00:00.000Z",
    );
    legacy.close();

    const migrated = openLocalTranscriptQuarantine(
      "legacy-project",
      home,
    );
    expect(await migrated.list()).toEqual([
      expect.objectContaining({
        sourceLocator: "legacy.jsonl",
        reason: "malformed-json",
      }),
    ]);
    await migrated.quarantine({
      sourceLocator: "deep.jsonl",
      sourceOrdinal: 2,
      reason: "nesting-too-deep",
      contentSha256: "b".repeat(64),
      quarantinedAt: new Date("2026-07-25T13:00:00.000Z"),
    });
    expect(await migrated.list({ reason: "nesting-too-deep" })).toEqual([
      expect.objectContaining({
        sourceLocator: "deep.jsonl",
        reason: "nesting-too-deep",
      }),
    ]);
    await migrated.close();

    const reopened = openLocalTranscriptQuarantine("legacy-project", home);
    expect(await reopened.list()).toHaveLength(2);
    await reopened.close();
  });

  it("rolls back quarantine schema migration failures", () => {
    const exec = vi.fn((sql: string) => {
      if (sql.includes("ALTER TABLE")) throw new Error("migration failed");
    });
    const oldSchemaDb = {
      exec,
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ sql: "CREATE TABLE transcript_quarantine (...)" })),
      })),
    };
    expect(() => new SQLiteLocalTranscriptQuarantineRepository(
      ":memory:migration",
      oldSchemaDb as never,
    )).toThrow("migration failed");
    expect(exec).toHaveBeenCalledWith("BEGIN IMMEDIATE");
    expect(exec).toHaveBeenCalledWith("ROLLBACK");

    const rollbackFailureDb = {
      exec: vi.fn((sql: string) => {
        if (sql.includes("ALTER TABLE")) throw new Error("original");
        if (sql === "ROLLBACK") throw new Error("rollback");
      }),
      prepare: oldSchemaDb.prepare,
    };
    expect(() => new SQLiteLocalTranscriptQuarantineRepository(
      ":memory:rollback-failure",
      rollbackFailureDb as never,
    )).toThrow("original");
  });

  it("fails closed if an injected database returns corrupt rows", async () => {
    const fakeDb = {
      exec: vi.fn(),
      prepare: vi.fn((sql: string) => ({
        run: vi.fn(),
        get: vi.fn(() => sql.includes("WHERE quarantine_id")
          ? {
              quarantine_id: Number.MAX_SAFE_INTEGER + 1,
              source_locator: "source",
              source_ordinal: 0,
              reason: "malformed-json",
              content_sha256: "a".repeat(64),
              quarantined_at: new Date().toISOString(),
            }
          : undefined),
        all: vi.fn(() => [{
          quarantine_id: 1,
          source_locator: "source",
          source_ordinal: -1,
          reason: "malformed-json",
          content_sha256: "a".repeat(64),
          quarantined_at: new Date().toISOString(),
        }]),
      })),
    };
    const repo = new SQLiteLocalTranscriptQuarantineRepository(
      ":memory:",
      fakeDb as never,
    );
    await expect(repo.get(1)).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
    });
    await expect(repo.list()).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
    });

    const invalidDateDb = {
      exec: vi.fn(),
      prepare: vi.fn(() => ({
        get: vi.fn(() => undefined),
        all: vi.fn(() => [{
          quarantine_id: 1,
          source_locator: "source",
          source_ordinal: 0,
          reason: "malformed-json",
          content_sha256: "a".repeat(64),
          quarantined_at: "not-a-date",
        }]),
      })),
    };
    const invalidDateRepo = new SQLiteLocalTranscriptQuarantineRepository(
      ":memory:invalid-date",
      invalidDateDb as never,
    );
    await expect(invalidDateRepo.list()).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
    });

    const missingRowDb = {
      exec: vi.fn(),
      prepare: vi.fn(() => ({
        run: vi.fn(),
        get: vi.fn(() => undefined),
      })),
    };
    const missingRowRepo = new SQLiteLocalTranscriptQuarantineRepository(
      ":memory:missing",
      missingRowDb as never,
    );
    await expect(missingRowRepo.quarantine({
      sourceLocator: "source",
      sourceOrdinal: 0,
      reason: "malformed-json",
      contentSha256: "a".repeat(64),
      quarantinedAt: new Date(),
    })).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
  });
});
