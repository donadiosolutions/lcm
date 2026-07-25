import { createHash } from "node:crypto";
import {
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  JsonObject,
  JsonValue,
  NativeTranscriptBatchInput,
  NativeTranscriptBatchResult,
  NativeTranscriptCheckpointRecord,
  NativeTranscriptRepository,
  NativeTranscriptSessionMessageRecord,
} from "../../src/storage/contracts.js";
import {
  NATIVE_TRANSCRIPT_MAX_JSON_DEPTH,
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
  NativeTranscriptSourceChangedError,
  readNativeTranscriptJsonl,
  runNativeTranscriptBackfill as runNativeTranscriptBackfillCore,
  NATIVE_TRANSCRIPT_MAX_LINK_SOURCE_ORDINAL,
  SUPPORTED_NATIVE_TRANSCRIPT_FORMATS,
  type NativeTranscriptBackfillResult,
  type NativeTranscriptByteSource,
  type NativeTranscriptReadOutcome,
} from "../../src/storage/native-transcript-ingest.js";

const temporaryDirectories: string[] = [];
const DEFAULT_SCRUBBER_VERSION = createNativeTranscriptScrubber({
  globalPatterns: [],
  projectPatterns: [],
}).scrubberVersion;

type NativeTranscriptBackfillOptions =
  Parameters<typeof runNativeTranscriptBackfillCore>[0];

function runNativeTranscriptBackfill(
  options: Omit<
    NativeTranscriptBackfillOptions,
    "globalPatterns" | "projectPatterns"
  > & Partial<Pick<
    NativeTranscriptBackfillOptions,
    "globalPatterns" | "projectPatterns"
  >>,
): ReturnType<typeof runNativeTranscriptBackfillCore> {
  return runNativeTranscriptBackfillCore({
    globalPatterns: [],
    projectPatterns: [],
    ...options,
  });
}

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
    scrubber: createNativeTranscriptScrubber({
      globalPatterns: [],
      projectPatterns: [],
    }),
    clock: () => new Date("2026-07-25T12:00:00.000Z"),
    ...overrides,
  }));
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function mutateAfterCtimeTick(
  path: string,
  baselineCtimeNs: bigint,
  mutate: () => void,
): void {
  const waitState = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 3_000;
  do {
    mutate();
    if (statSync(path, { bigint: true }).ctimeNs !== baselineCtimeNs) {
      return;
    }
    Atomics.wait(waitState, 0, 0, 10);
  } while (Date.now() < deadline);
  throw new Error("filesystem did not expose a new ctime change cookie");
}

function forceDistinctMtime(path: string): void {
  const distinctTime = new Date(statSync(path).mtimeMs + 2_000);
  utimesSync(path, distinctTime, distinctTime);
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
      digestPrefix: vi.fn(async (length: number) =>
        digest(bytes.subarray(0, length))),
      assertByteRangesUnchanged: vi.fn(async (ranges) => {
        for (const range of ranges) {
          if (
            digest(bytes.subarray(
              range.startByteOffset,
              range.endByteOffset,
            )) !== range.rangeSha256
          ) {
            throw new NativeTranscriptSourceChangedError();
          }
        }
      }),
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
    checkpoint: {
      scrubberVersion: DEFAULT_SCRUBBER_VERSION,
      ...checkpointValue,
    },
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
      projectPatterns: [],
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
    expect(() => createNativeTranscriptScrubber(undefined as never))
      .toThrowError(NativeTranscriptConfigurationError);
    expect(() => createNativeTranscriptScrubber({
      globalPatterns: [],
    } as never)).toThrowError(NativeTranscriptConfigurationError);
    expect(() => createNativeTranscriptScrubber({
      globalPatterns: [42],
      projectPatterns: [],
    } as never)).toThrowError(NativeTranscriptConfigurationError);
    expect(() => createNativeTranscriptScrubber({
      globalPatterns: [],
      projectPatterns: [42],
    } as never)).toThrowError(NativeTranscriptConfigurationError);
    expect(() =>
      createNativeTranscriptScrubber({
        globalPatterns: ["["],
        projectPatterns: [],
      }))
      .toThrowError(NativeTranscriptConfigurationError);
    expect(() =>
      createNativeTranscriptScrubber({
        globalPatterns: [],
        projectPatterns: [],
        pipelineVersion: "",
      }))
      .toThrowError(
        expect.objectContaining({ code: "invalid-input" }),
      );
    expect(() =>
      createNativeTranscriptScrubber({
        globalPatterns: [],
        projectPatterns: [],
        pipelineVersion: "x\0y",
      }))
      .toThrowError(NativeTranscriptConfigurationError);
  });

  it("rejects patterns that redact built-in mapper structure", () => {
    for (const pattern of [
      "message",
      "payload",
      "type",
      "role",
      "content",
      "text",
      "response_item",
      "tool_result",
      "input_text",
      "output_text",
      "user",
      "assistant",
      "system",
      '"message"\\s*:',
      '"type"\\s*:\\s*"response_item"',
      'role(?=":)',
    ]) {
      expect(() => createNativeTranscriptScrubber({
        globalPatterns: [pattern],
        projectPatterns: [],
      })).toThrowError(expect.objectContaining({
        code: "invalid-patterns",
      }));
    }
    for (const pattern of [
      "^messages$",
      "^payloads$",
      "^response_items$",
      "^tool_results$",
      "^contents$",
    ]) {
      expect(() => createNativeTranscriptScrubber({
        globalPatterns: [pattern],
        projectPatterns: [],
      })).not.toThrow();
    }
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

  it("reports exact raw byte ranges for records and blank checkpoint spans", async () => {
    const content = "\n{}\r\n \t\n[]";
    const progress: Array<{
      startByteOffset: number;
      endByteOffset: number;
      rangeSha256: string;
    }> = [];
    const outcomes = await collect(byteChunks(content), {
      onProgress: (entry) => progress.push(entry),
    });
    expect(outcomes).toHaveLength(2);
    const spans = ["\n", "{}\r\n", " \t\n", "[]"];
    let startByteOffset = 0;
    expect(progress.map((entry) => ({
      startByteOffset: entry.startByteOffset,
      endByteOffset: entry.endByteOffset,
      rangeSha256: entry.rangeSha256,
    }))).toEqual(spans.map((span) => {
      const endByteOffset = startByteOffset + Buffer.byteLength(span);
      const entry = {
        startByteOffset,
        endByteOffset,
        rangeSha256: digest(span),
      };
      startByteOffset = endByteOffset;
      return entry;
    }));

    const trimmedProgress: typeof progress = [];
    await collect(byteChunks(content), {
      progressStartByteOffset: 2,
      onProgress: (entry) => trimmedProgress.push(entry),
    });
    expect(trimmedProgress).toEqual([
      {
        startByteOffset: 2,
        endByteOffset: 5,
        rangeSha256: digest("}\r\n"),
        prefixSha256: digest("\n{}\r\n"),
      },
      {
        startByteOffset: 5,
        endByteOffset: 8,
        rangeSha256: digest(" \t\n"),
        prefixSha256: digest("\n{}\r\n \t\n"),
      },
      {
        startByteOffset: 8,
        endByteOffset: 10,
        rangeSha256: digest("[]"),
        prefixSha256: digest(content),
      },
    ]);
  });

  it("quarantines malformed, scalar, NUL, binary, invalid UTF-8, and oversized records", async () => {
    const invalidUtf8 = Uint8Array.of(0xff, 0x0a);
    const outcomes = await collect(byteChunks(
      '{"bad":}\n',
      '{"value":-x}\n',
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

  it("quarantines lossy decimal tokens while preserving exact JSON spellings", async () => {
    const outcomes = await collect(byteChunks([
      '{"value":9007199254740993}',
      '{"value":9007199254740992}',
      '{"value":-9007199254740992}',
      '{"value":9007199254740992.0}',
      '{"value":9007199254740992e0}',
      '{"value":9.007199254740992e15}',
      '{"value":1e16}',
      '{"value":0.10000000000000001}',
      '{"value":1.23456789012345678}',
      '{"value":1e-4000}',
      '{"value":1e9007199254740992}',
      '{"value":1e99999999999999999}',
      `{"value":1${"0".repeat(20_000)}}`,
      '{"values":[0.1,1.0,1e3,-0,-0e99999999999999999,9007199254740991,-9007199254740991,4503599627370495.5,1.25e3],"text":"9007199254740993"}',
    ].join("\n")));
    expect(outcomes.slice(0, 13).every((outcome) =>
      outcome.kind === "quarantine"
      && outcome.reason === "malformed-json"
    )).toBe(true);
    const accepted = outcomes[13];
    expect(accepted).toMatchObject({
      kind: "record",
      nativePayload: {
        values: [
          0.1,
          1,
          1_000,
          -0,
          -0,
          Number.MAX_SAFE_INTEGER,
          Number.MIN_SAFE_INTEGER,
          4_503_599_627_370_495.5,
          1_250,
        ],
        text: "9007199254740993",
      },
    });
    if (accepted?.kind !== "record") throw new Error("expected record");
    const values = accepted.nativePayload.values;
    expect(
      Array.isArray(values)
      && Object.is(values[3], -0)
      && Object.is(values[4], -0),
    ).toBe(true);
    expect(canonicalNativeTranscriptJson(accepted.nativePayload)).toBe(
      '{"text":"9007199254740993","values":[0.1,1,1000,0,0,9007199254740991,-9007199254740991,4503599627370495.5,1250]}',
    );
  });

  it("quarantines lone surrogate code units in string keys and values", async () => {
    const outcomes = await collect(byteChunks([
      '{"value":"\\ud800"}',
      '{"value":"\\udc00"}',
      '{"\\ud800":"value"}',
      '{"\\udc00":"value"}',
      '{"literal":"😀","escaped":"\\ud83d\\ude00","key\\ud83d\\ude00":"ok"}',
    ].join("\n")));
    expect(outcomes.slice(0, 4)).toEqual([
      expect.objectContaining({
        kind: "quarantine",
        reason: "malformed-json",
      }),
      expect.objectContaining({
        kind: "quarantine",
        reason: "malformed-json",
      }),
      expect.objectContaining({
        kind: "quarantine",
        reason: "malformed-json",
      }),
      expect.objectContaining({
        kind: "quarantine",
        reason: "malformed-json",
      }),
    ]);
    expect(outcomes[4]).toMatchObject({
      kind: "record",
      nativePayload: {
        literal: "😀",
        escaped: "😀",
        "key😀": "ok",
      },
    });
  });

  it("quarantines duplicate decoded object keys before parsing or scrubbing", async () => {
    const outcomes = await collect(byteChunks([
      '{"canary":"first","canary":"second"}',
      '{"canary":1,"\\u0063anary":2}',
      '{"outer":{"secret":"first","secret":"second"}}',
      '[{"nested":1,"\\u006eested":2}]',
      '{"space" :1,"space":2}',
      '{"\\x":1}',
      '{"é":1,"\\u00e9":2}',
      '{"😀":1,"\\ud83d\\ude00":2}',
      '{"left":{"same":1},"right":{"same":2}}',
      '{"same":{"same":1}}',
      '["same","same","{","]",":"]',
      '{"quote\\\"key":1,"slash\\\\key":2}',
    ].join("\n")));
    expect(outcomes.slice(0, 8)).toEqual([
      expect.objectContaining({ kind: "quarantine", reason: "malformed-json" }),
      expect.objectContaining({ kind: "quarantine", reason: "malformed-json" }),
      expect.objectContaining({ kind: "quarantine", reason: "malformed-json" }),
      expect.objectContaining({ kind: "quarantine", reason: "malformed-json" }),
      expect.objectContaining({ kind: "quarantine", reason: "malformed-json" }),
      expect.objectContaining({ kind: "quarantine", reason: "malformed-json" }),
      expect.objectContaining({ kind: "quarantine", reason: "malformed-json" }),
      expect.objectContaining({ kind: "quarantine", reason: "malformed-json" }),
    ]);
    expect(outcomes.slice(8)).toEqual([
      expect.objectContaining({
        kind: "record",
        nativePayload: {
          left: { same: 1 },
          right: { same: 2 },
        },
      }),
      expect.objectContaining({
        kind: "record",
        nativePayload: { same: { same: 1 } },
      }),
      expect.objectContaining({
        kind: "record",
        nativePayload: ["same", "same", "{", "]", ":"],
      }),
      expect.objectContaining({
        kind: "record",
        nativePayload: {
          'quote"key': 1,
          "slash\\key": 2,
        },
      }),
    ]);
    expect(JSON.stringify(outcomes.slice(0, 8))).not.toContain("second");
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
        projectPatterns: [],
      }),
    });
    expect(collision[0]).toMatchObject({
      kind: "quarantine",
      reason: "redacted-key-collision",
    });

    const residual = await collect(byteChunks('{"value":"secret"}\n'), {
      scrubber: createNativeTranscriptScrubber({
        globalPatterns: ["secret", "RED"],
        projectPatterns: [],
      }),
    });
    expect(residual[0]).toMatchObject({
      kind: "quarantine",
      reason: "residual-secret",
    });

    const structuredCanary = "abcdefghijklmnopqrstuvwxyz123456";
    const structured = await collect(byteChunks(
      `{"algolia_api_key":"${structuredCanary}"}\n`,
    ));
    expect(structured[0]).toMatchObject({
      kind: "quarantine",
      reason: "residual-secret",
    });
    expect(JSON.stringify(structured)).not.toContain(structuredCanary);

    const specialCollision = await collect(byteChunks(
      '{"__proto__":1,"secret":2}\n',
    ), {
      scrubber: createNativeTranscriptScrubber({
        globalPatterns: ["(?:__proto__|secret)"],
        projectPatterns: [],
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
      scrubber: createNativeTranscriptScrubber({
        globalPatterns: [],
        projectPatterns: [],
      }),
    };
    for (const sourceLocator of [
      "../secret",
      "nested/../secret",
      "nested\\..\\secret",
      "/absolute",
      "\\absolute",
      "\\\\server\\share",
      "C:\\secret",
      "C:/secret",
      "C:secret",
    ]) {
      await expect(Array.fromAsync(readNativeTranscriptJsonl({
        ...base,
        sourceLocator,
      }))).rejects.toThrowError(NativeTranscriptConfigurationError);
    }
    for (const sourceLocator of [
      "foo..bar",
      "dir/.../file",
      "資料/😀.jsonl",
    ]) {
      await expect(Array.fromAsync(readNativeTranscriptJsonl({
        ...base,
        bytes: byteChunks("{}"),
        sourceLocator,
      }))).resolves.toHaveLength(1);
    }
    await expect(Array.fromAsync(readNativeTranscriptJsonl({
      ...base,
      nativeSessionId: "",
    }))).rejects.toThrowError(NativeTranscriptConfigurationError);
    await expect(Array.fromAsync(readNativeTranscriptJsonl({
      ...base,
      maxRecordBytes: 0,
    }))).rejects.toThrowError(NativeTranscriptConfigurationError);
    for (const progressStartByteOffset of [-1, 0.5]) {
      await expect(Array.fromAsync(readNativeTranscriptJsonl({
        ...base,
        progressStartByteOffset,
      }))).rejects.toThrowError(NativeTranscriptConfigurationError);
    }
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
      role: "user",
      content: "one\ntwo",
      sourceOrdinal: 9,
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
      role: "system",
      content: "system",
      sourceOrdinal: 11,
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
      role: "user",
      content: "direct",
      sourceOrdinal: 1,
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
      role: "assistant",
      content: "answer",
      sourceOrdinal: 1,
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
    await snapshot.assertByteRangesUnchanged([{
      startByteOffset: 0,
      endByteOffset: 10,
      rangeSha256: digest(Buffer.from(content).subarray(0, 10)),
    }]);
    for (const ranges of [
      [{
        startByteOffset: 1,
        endByteOffset: 1,
        rangeSha256: digest(""),
      }],
      [{
        startByteOffset: 0,
        endByteOffset: metadata.sizeBytes + 1,
        rangeSha256: digest(content),
      }],
      [{
        startByteOffset: 0,
        endByteOffset: 1,
        rangeSha256: "bad",
      }],
      [
        {
          startByteOffset: 0,
          endByteOffset: 1,
          rangeSha256: digest(Buffer.from(content).subarray(0, 1)),
        },
        {
          startByteOffset: 2,
          endByteOffset: 3,
          rangeSha256: digest(Buffer.from(content).subarray(2, 3)),
        },
      ],
    ]) {
      await expect(snapshot.assertByteRangesUnchanged(ranges))
        .rejects.toThrowError(NativeTranscriptConfigurationError);
    }
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
    await expect(shrinkingSnapshot.assertByteRangesUnchanged([{
      startByteOffset: 0,
      endByteOffset: 5,
      rangeSha256: digest("12345"),
    }])).rejects.toThrowError(NativeTranscriptSourceChangedError);
    await shrinkingSnapshot.close();
  });

  it("keeps an atomic path replacement bound to the opened inode", async () => {
    const root = temporaryDirectory();
    const path = join(root, "source.jsonl");
    const moved = join(root, "original.jsonl");
    const temporaryLink = join(root, "source-link.jsonl");
    const original = '{"value":"original"}\n';
    writeFileSync(path, original);
    const baselineCtimeNs = statSync(path, { bigint: true }).ctimeNs;
    const repo = repository();
    await runNativeTranscriptBackfill({
      repository: repo,
      quarantine: {
        clientName: "claude-code",
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: createFileNativeTranscriptSource(root, "source.jsonl", {
        _afterSnapshotOpenForTesting: () => {
          mutateAfterCtimeTick(path, baselineCtimeNs, () => {
            linkSync(path, temporaryLink);
            unlinkSync(temporaryLink);
          });
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
        clientName: "claude-code",
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: createFileNativeTranscriptSource(root, "source.jsonl", {
        _beforeDigestPrefixForTesting: () => {
          writeFileSync(path, '{"value":"eno"}\n' + second);
          forceDistinctMtime(path);
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
        clientName: "claude-code",
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
        clientName: "claude-code",
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
        clientName: "claude-code",
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: createFileNativeTranscriptSource(root, "source.jsonl", {
        chunkBytes: Buffer.byteLength(first),
        _afterChunkForTesting: (ordinal) => {
          if (ordinal === 0) {
            writeFileSync(path, second + first);
          }
        },
        _forceMetadataUnchangedForTesting: true,
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
    const baselineCtimeNs = statSync(path, { bigint: true }).ctimeNs;
    const restoredMtimeRepo = repository();
    await expect(runNativeTranscriptBackfill({
      repository: restoredMtimeRepo,
      quarantine: {
        clientName: "claude-code",
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: createFileNativeTranscriptSource(root, "source.jsonl", {
        _beforeStreamForTesting: () => {
          mutateAfterCtimeTick(path, baselineCtimeNs, () => {
            writeFileSync(path, second + first);
            utimesSync(path, fixedTime, fixedTime);
          });
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
    const missingBaselineCtimeNs =
      statSync(path, { bigint: true }).ctimeNs;
    const temporaryLink = join(root, "missing-link.jsonl");
    const missingLocatorRepo = repository();
    await expect(runNativeTranscriptBackfill({
      repository: missingLocatorRepo,
      quarantine: {
        clientName: "claude-code",
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: createFileNativeTranscriptSource(root, "source.jsonl", {
        _beforeStreamForTesting: () => {
          mutateAfterCtimeTick(path, missingBaselineCtimeNs, () => {
            linkSync(path, temporaryLink);
            unlinkSync(temporaryLink);
          });
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

  it("fences a source rewrite or append after the destination commit", async () => {
    for (const mutation of ["rewrite", "append"] as const) {
      const root = temporaryDirectory();
      const path = join(root, `${mutation}.jsonl`);
      const original = '{"value":"one"}\n';
      writeFileSync(path, original);
      const repo = repository();
      let releaseCommit!: () => void;
      const commitGate = new Promise<void>((resolve) => {
        releaseCommit = resolve;
      });
      let markCommitStarted!: () => void;
      const commitStarted = new Promise<void>((resolve) => {
        markCommitStarted = resolve;
      });
      vi.mocked(repo.ingestBatch).mockImplementationOnce(async (input) => {
        repo.batches.push(input);
        markCommitStarted();
        await commitGate;
        return {
          importedCount: input.records.length,
          skippedCount: 0,
          quarantinedCount: input.quarantinedCount,
          checkpoint: checkpoint(input.checkpoint.checkpoint),
        };
      });
      const pending = runNativeTranscriptBackfill({
        repository: repo,
        quarantine: {
          clientName: "claude-code",
          quarantine: vi.fn(),
          get: vi.fn(),
          list: vi.fn(),
          close: vi.fn(),
        },
        source: createFileNativeTranscriptSource(root, `${mutation}.jsonl`),
        machineId: "machine",
        format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
        nativeSessionId: "session-1",
        sourceLocator: `${mutation}.jsonl`,
        messageResolver: { resolveExact: vi.fn(async () => null) },
      });
      await commitStarted;
      if (mutation === "append") {
        writeFileSync(path, '{"value":"two"}\n', { flag: "a" });
      } else {
        writeFileSync(path, '{"value":"eno"}\n');
      }
      forceDistinctMtime(path);
      releaseCommit();
      await expect(pending).rejects.toThrowError(
        NativeTranscriptSourceChangedError,
      );
      expect(repo.batches).toHaveLength(1);
    }
  });

  it("fences checkpoint-only and empty-source writes after commit", async () => {
    for (const testCase of [
      { name: "blank", content: " \n" },
      { name: "empty", content: "" },
    ]) {
      const root = temporaryDirectory();
      const path = join(root, `${testCase.name}.jsonl`);
      writeFileSync(path, testCase.content);
      const repo = repository();
      let releaseCommit!: () => void;
      const commitGate = new Promise<void>((resolve) => {
        releaseCommit = resolve;
      });
      let markCommitStarted!: () => void;
      const commitStarted = new Promise<void>((resolve) => {
        markCommitStarted = resolve;
      });
      vi.mocked(repo.ingestBatch).mockImplementationOnce(async (input) => {
        repo.batches.push(input);
        markCommitStarted();
        await commitGate;
        return {
          importedCount: 0,
          skippedCount: 0,
          quarantinedCount: 0,
          checkpoint: checkpoint(input.checkpoint.checkpoint),
        };
      });
      const pending = runNativeTranscriptBackfill({
        repository: repo,
        quarantine: {
          clientName: "claude-code",
          quarantine: vi.fn(),
          get: vi.fn(),
          list: vi.fn(),
          close: vi.fn(),
        },
        source: createFileNativeTranscriptSource(
          root,
          `${testCase.name}.jsonl`,
        ),
        machineId: "machine",
        format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
        nativeSessionId: "session-1",
        sourceLocator: `${testCase.name}.jsonl`,
        messageResolver: { resolveExact: vi.fn(async () => null) },
      });
      await commitStarted;
      writeFileSync(path, "{}\n", { flag: "a" });
      forceDistinctMtime(path);
      releaseCommit();
      await expect(pending).rejects.toThrowError(
        NativeTranscriptSourceChangedError,
      );
      expect(repo.batches).toHaveLength(1);
      expect(repo.batches[0]?.records).toEqual([]);
    }
  });

  it("preserves a repository failure when the source changes during commit", async () => {
    const root = temporaryDirectory();
    const path = join(root, "repository-failure.jsonl");
    writeFileSync(path, '{"value":"one"}\n');
    const repo = repository();
    const repositoryFailure = new Error("commit outcome unknown");
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let markCommitStarted!: () => void;
    const commitStarted = new Promise<void>((resolve) => {
      markCommitStarted = resolve;
    });
    vi.mocked(repo.ingestBatch).mockImplementationOnce(async (input) => {
      repo.batches.push(input);
      markCommitStarted();
      await commitGate;
      throw repositoryFailure;
    });
    const pending = runNativeTranscriptBackfill({
      repository: repo,
      quarantine: {
        clientName: "claude-code",
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: createFileNativeTranscriptSource(
        root,
        "repository-failure.jsonl",
      ),
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "repository-failure.jsonl",
      messageResolver: { resolveExact: vi.fn(async () => null) },
    });
    await commitStarted;
    writeFileSync(path, '{"value":"two"}\n', { flag: "a" });
    forceDistinctMtime(path);
    releaseCommit();
    await expect(pending).rejects.toBe(repositoryFailure);
    expect(repo.batches).toHaveLength(1);
  });

  it("fences a replayed prefix mutation before destination access", async () => {
    const root = temporaryDirectory();
    const path = join(root, "prefix-before-commit.jsonl");
    const prefix =
      '{"message":{"role":"user","content":"first"}}\n';
    const changedPrefix =
      '{"message":{"role":"user","content":"tsrif"}}\n';
    const suffix =
      '{"message":{"role":"assistant","content":"second"}}\n';
    writeFileSync(path, prefix + suffix);
    const repo = repository(checkpoint({
      version: 1,
      byteOffset: Buffer.byteLength(prefix),
      prefixSha256: digest(prefix),
      source: {
        sizeBytes: Buffer.byteLength(prefix),
        modifiedAtMs: 1,
        changedAtMs: 1,
      },
    }));
    let releaseResolver!: () => void;
    const resolverGate = new Promise<void>((resolve) => {
      releaseResolver = resolve;
    });
    let markResolverStarted!: () => void;
    const resolverStarted = new Promise<void>((resolve) => {
      markResolverStarted = resolve;
    });
    const pending = runNativeTranscriptBackfill({
      repository: repo,
      quarantine: {
        clientName: "claude-code",
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: createFileNativeTranscriptSource(
        root,
        "prefix-before-commit.jsonl",
        { _forceMetadataUnchangedForTesting: true },
      ),
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "prefix-before-commit.jsonl",
      messageResolver: {
        resolveExact: vi.fn(async () => {
          markResolverStarted();
          await resolverGate;
          return { conversationId: 1, messageId: 2 };
        }),
      },
    });
    await resolverStarted;
    writeFileSync(path, changedPrefix + suffix);
    releaseResolver();
    await expect(pending).rejects.toThrowError(
      NativeTranscriptSourceChangedError,
    );
    expect(repo.batches).toEqual([]);
  });

  it("fences a replayed prefix mutation after destination commit", async () => {
    const root = temporaryDirectory();
    const path = join(root, "prefix-after-commit.jsonl");
    const prefix = '{"event":"prefix-a"}\n';
    const changedPrefix = '{"event":"prefix-b"}\n';
    const suffix = '{"event":"suffix"}\n';
    writeFileSync(path, prefix + suffix);
    const repo = repository(checkpoint({
      version: 1,
      byteOffset: Buffer.byteLength(prefix),
      prefixSha256: digest(prefix),
      source: {
        sizeBytes: Buffer.byteLength(prefix),
        modifiedAtMs: 1,
        changedAtMs: 1,
      },
    }));
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let markCommitStarted!: () => void;
    const commitStarted = new Promise<void>((resolve) => {
      markCommitStarted = resolve;
    });
    vi.mocked(repo.ingestBatch).mockImplementationOnce(async (input) => {
      repo.batches.push(input);
      markCommitStarted();
      await commitGate;
      return {
        importedCount: input.records.length,
        skippedCount: 0,
        quarantinedCount: input.quarantinedCount,
        checkpoint: checkpoint(input.checkpoint.checkpoint),
      };
    });
    const pending = runNativeTranscriptBackfill({
      repository: repo,
      quarantine: {
        clientName: "claude-code",
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: createFileNativeTranscriptSource(
        root,
        "prefix-after-commit.jsonl",
        { _forceMetadataUnchangedForTesting: true },
      ),
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "prefix-after-commit.jsonl",
      messageResolver: { resolveExact: vi.fn(async () => null) },
    });
    await commitStarted;
    writeFileSync(path, changedPrefix + suffix);
    releaseCommit();
    await expect(pending).rejects.toThrowError(
      NativeTranscriptSourceChangedError,
    );
    expect(repo.batches).toHaveLength(1);
  });
});

describe("exact native transcript message resolver", () => {
  it("resolves exact messages across every conversation in session-wide order", async () => {
    const olderMessage: NativeTranscriptSessionMessageRecord = {
      messageId: 9,
      conversationId: 7,
      messageSequence: 0,
      role: "user",
      content: "question",
    };
    const newerMessage: NativeTranscriptSessionMessageRecord = {
      messageId: 10,
      conversationId: 4,
      messageSequence: 0,
      role: "assistant",
      content: "scrubbed",
    };
    const getNativeTranscriptMessageSnapshot = vi.fn(async () => [
      olderMessage,
      newerMessage,
    ]);
    const resolver = createExactNativeTranscriptMessageResolver({
      getNativeTranscriptMessageSnapshot,
    });
    const input = {
      nativeSessionId: "session-1",
      sessionSequence: 1,
      role: "assistant" as const,
      content: "scrubbed",
    };
    await expect(Promise.all([
      resolver.resolveExact(input),
      resolver.resolveExact({
        ...input,
        sessionSequence: 0,
        role: "user",
        content: "question",
      }),
    ])).resolves.toEqual([
      { conversationId: 4, messageId: 10 },
      { conversationId: 7, messageId: 9 },
    ]);
    expect(getNativeTranscriptMessageSnapshot).toHaveBeenCalledWith("session-1");

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
    expect(getNativeTranscriptMessageSnapshot).toHaveBeenCalledTimes(1);

    const emptyResolver = createExactNativeTranscriptMessageResolver({
      getNativeTranscriptMessageSnapshot: vi.fn(async () => []),
    });
    await expect(emptyResolver.resolveExact(input)).resolves.toBeNull();
  });

  it("shares a failed snapshot load and evicts it before a retry", async () => {
    let rejectLoad!: (error: Error) => void;
    const failedLoad = new Promise<readonly NativeTranscriptSessionMessageRecord[]>(
      (_resolve, reject) => {
        rejectLoad = reject;
      },
    );
    const recovered: readonly NativeTranscriptSessionMessageRecord[] = [{
      conversationId: 7,
      messageId: 9,
      messageSequence: 0,
      role: "user",
      content: "question",
    }];
    const getNativeTranscriptMessageSnapshot = vi.fn()
      .mockImplementationOnce(() => failedLoad)
      .mockResolvedValue(recovered);
    const resolver = createExactNativeTranscriptMessageResolver({
      getNativeTranscriptMessageSnapshot,
    });
    const input = {
      nativeSessionId: "session-1",
      sessionSequence: 0,
      role: "user" as const,
      content: "question",
    };
    const first = resolver.resolveExact(input);
    const concurrent = resolver.resolveExact(input);
    expect(getNativeTranscriptMessageSnapshot).toHaveBeenCalledTimes(1);
    const failure = new Error("snapshot failed");
    const firstRejection = expect(first).rejects.toBe(failure);
    const concurrentRejection = expect(concurrent).rejects.toBe(failure);
    rejectLoad(failure);
    await Promise.all([firstRejection, concurrentRejection]);

    await expect(resolver.resolveExact(input)).resolves.toEqual({
      conversationId: 7,
      messageId: 9,
    });
    expect(getNativeTranscriptMessageSnapshot).toHaveBeenCalledTimes(2);
  });

  it("rejects inconsistent ordered snapshot rows", async () => {
    const message = (
      conversationId: number,
      messageId: number,
      messageSequence = 0,
    ): NativeTranscriptSessionMessageRecord => ({
      messageId,
      conversationId,
      messageSequence,
      role: "user" as const,
      content: `message-${messageId}`,
    });
    const input = {
      nativeSessionId: "session-1",
      sessionSequence: 0,
      role: "user" as const,
      content: "message-1",
    };
    const resolveWith = (snapshot: readonly NativeTranscriptSessionMessageRecord[]) =>
      createExactNativeTranscriptMessageResolver({
        getNativeTranscriptMessageSnapshot: vi.fn(async () => snapshot),
      }).resolveExact(input);

    await expect(resolveWith([
      message(1, 1),
      message(1, 3, 1),
      message(2, 2),
    ])).resolves.toEqual({ conversationId: 1, messageId: 1 });
    await expect(resolveWith([
      message(1, 1),
      message(2, 2),
      message(1, 3, 1),
    ])).resolves.toBeNull();
    await expect(resolveWith([
      { ...message(1, 1), conversationId: -1 },
    ])).resolves.toBeNull();
    await expect(resolveWith([
      { ...message(1, 1), messageId: -1 },
    ])).resolves.toBeNull();
    await expect(resolveWith([
      { ...message(1, 1), messageSequence: -1 },
    ])).resolves.toBeNull();
    await expect(resolveWith([
      { ...message(1, 1), role: "developer" as never },
    ])).resolves.toBeNull();
    await expect(resolveWith([
      { ...message(1, 1), content: "bad\0content" },
    ])).resolves.toBeNull();
    await expect(resolveWith([
      message(1, 1, 1),
    ])).resolves.toBeNull();
  });

  it("rejects invalid resolver inputs before snapshot access", async () => {
    const getNativeTranscriptMessageSnapshot = vi.fn();
    const resolver = createExactNativeTranscriptMessageResolver({
      getNativeTranscriptMessageSnapshot,
    });
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
    expect(getNativeTranscriptMessageSnapshot).not.toHaveBeenCalled();
  });
});

describe("native transcript backfill coordinator", () => {
  it("validates scrubbers before touching source or destination", async () => {
    const repo = repository();
    const byteSource = source("{}\n");
    const markerQuarantine = vi.fn();
    const markerResolver = vi.fn();
    await expect(runNativeTranscriptBackfill({
      repository: repo,
      quarantine: {
        clientName: "claude-code",
        quarantine: markerQuarantine,
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

    await expect(runNativeTranscriptBackfill({
      repository: repo,
      quarantine: {
        clientName: "claude-code",
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
      globalPatterns: ['"message"\\s*:'],
      messageResolver: { resolveExact: markerResolver },
    })).rejects.toMatchObject({ code: "invalid-patterns" });
    expect(byteSource.openSnapshot).not.toHaveBeenCalled();
    expect(repo.getCheckpoint).not.toHaveBeenCalled();
    expect(repo.ingestBatch).not.toHaveBeenCalled();
    expect(markerQuarantine).not.toHaveBeenCalled();
    expect(markerResolver).not.toHaveBeenCalled();

    await expect(runNativeTranscriptBackfill({
      repository: repo,
      quarantine: {
        clientName: "codex",
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
      globalPatterns: [],
      projectPatterns: [],
      messageResolver: { resolveExact: vi.fn(async () => null) },
    })).rejects.toMatchObject({ code: "invalid-input" });
    expect(byteSource.openSnapshot).not.toHaveBeenCalled();

    await expect(runNativeTranscriptBackfillCore({
      repository: repo,
      quarantine: {
        clientName: "claude-code",
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
      messageResolver: { resolveExact: vi.fn(async () => null) },
    } as never)).rejects.toMatchObject({ code: "invalid-input" });
    expect(byteSource.openSnapshot).not.toHaveBeenCalled();
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
        clientName: "claude-code",
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
            sessionSequence: 0,
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

  it("preserves a quarantined message position before an identical later message", async () => {
    const collision =
      '{"message":{"role":"user","content":"same"},'
      + '"canary_secret":"a","[REDACTED]":"b"}\n';
    const later =
      '{"message":{"role":"user","content":"same"}}\n';
    const repo = repository();
    const quarantine = vi.fn();
    const resolveExact = vi.fn(async (input) =>
      input.sessionSequence === 1
        ? {
            conversationId: 4,
            messageId: input.sessionSequence + 10,
          }
        : null);
    await runNativeTranscriptBackfill({
      repository: repo,
      quarantine: {
        clientName: "claude-code",
        quarantine,
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: source(collision + later),
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "sessions/session.jsonl",
      globalPatterns: ["canary_secret"],
      messageResolver: { resolveExact },
    });
    expect(resolveExact.mock.calls.map(([input]) => input.sessionSequence))
      .toEqual([0, 1]);
    expect(repo.batches[0]?.records[0]?.messageLinks).toEqual([{
      conversationId: 4,
      messageId: 11,
      sourceOrdinal: 1,
    }]);
    expect(quarantine).toHaveBeenCalledTimes(1);
    expect(quarantine).toHaveBeenCalledWith(expect.objectContaining({
      sourceOrdinal: 0,
      reason: "redacted-key-collision",
    }));
    expect(JSON.stringify([repo.batches, quarantine.mock.calls]))
      .not.toContain("canary_secret");
  });

  it("fails closed before resolver access for custom mapping after an unknown quarantine", async () => {
    const repo = repository();
    const resolveExact = vi.fn();
    await expect(runNativeTranscriptBackfill({
      repository: repo,
      quarantine: {
        clientName: "claude-code",
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: source('{"bad":}\n{"message":"anchor"}\n'),
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "sessions/session.jsonl",
      batchSize: 1,
      messageMapper: {
        map: (_format, payload, sourceOrdinal) =>
          (payload as JsonObject).message === "anchor"
            ? [{ role: "user", content: "anchor", sourceOrdinal }]
            : [],
      },
      messageResolver: { resolveExact },
    })).rejects.toBeInstanceOf(NativeTranscriptLinkError);
    expect(resolveExact).not.toHaveBeenCalled();
    expect(repo.batches).toHaveLength(1);
  });

  it("requires one unique destination position after unknown quarantines", async () => {
    const content = [
      '{"bad":}',
      '{"message":{"role":"user","content":"anchor"}}',
    ].join("\n");
    const run = async (
      matchingSequences: readonly number[],
    ): Promise<{
      readonly repo: ReturnType<typeof repository>;
      readonly resolveExact: ReturnType<typeof vi.fn>;
      readonly result: Promise<NativeTranscriptBackfillResult>;
    }> => {
      const repo = repository();
      const resolveExact = vi.fn(async (input) =>
        matchingSequences.includes(input.sessionSequence)
          ? {
              conversationId: 4,
              messageId: input.sessionSequence + 10,
            }
          : null);
      return {
        repo,
        resolveExact,
        result: runNativeTranscriptBackfill({
          repository: repo,
          quarantine: {
            clientName: "claude-code",
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
          batchSize: 1,
          messageResolver: { resolveExact },
        }),
      };
    };

    const unique = await run([1]);
    await expect(unique.result).resolves.toMatchObject({
      importedCount: 1,
      quarantinedCount: 1,
    });
    expect(unique.repo.batches).toHaveLength(2);
    expect(unique.repo.batches[1]?.records[0]?.messageLinks).toEqual([{
      conversationId: 4,
      messageId: 11,
      sourceOrdinal: 1,
    }]);

    const absent = await run([]);
    await expect(absent.result).rejects.toBeInstanceOf(
      NativeTranscriptLinkError,
    );
    expect(absent.resolveExact).toHaveBeenCalledTimes(2);
    expect(absent.repo.batches).toHaveLength(1);

    const duplicate = await run([0, 1]);
    await expect(duplicate.result).rejects.toBeInstanceOf(
      NativeTranscriptLinkError,
    );
    expect(duplicate.resolveExact).toHaveBeenCalledTimes(2);
    expect(duplicate.repo.batches).toHaveLength(1);
  });

  it("replays a trailing unknown quarantine before an appended anchor", async () => {
    const quarantinedPrefix = '{"bad":}\n';
    const appended =
      '{"message":{"role":"assistant","content":"anchor"}}\n';
    const previous = checkpoint({
      version: 1,
      byteOffset: Buffer.byteLength(quarantinedPrefix),
      prefixSha256: digest(quarantinedPrefix),
      source: {
        sizeBytes: Buffer.byteLength(quarantinedPrefix),
        modifiedAtMs: 1,
        changedAtMs: 1,
      },
    });
    const repo = repository(previous);
    const resolveExact = vi.fn(async (input) =>
      input.sessionSequence === 1
        ? { conversationId: 7, messageId: 9 }
        : null);
    await runNativeTranscriptBackfill({
      repository: repo,
      quarantine: {
        clientName: "claude-code",
        quarantine: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        close: vi.fn(),
      },
      source: source(quarantinedPrefix + appended),
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "sessions/session.jsonl",
      messageResolver: { resolveExact },
    });
    expect(resolveExact.mock.calls.map(([input]) => input.sessionSequence))
      .toEqual([0, 1]);
    expect(repo.batches[0]?.expectedCheckpoint).toBe(previous);
    expect(repo.batches[0]?.records[0]?.messageLinks).toEqual([{
      conversationId: 7,
      messageId: 9,
      sourceOrdinal: 1,
    }]);
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
        clientName: "claude-code",
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
        clientName: "claude-code",
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
          scrubberVersion: DEFAULT_SCRUBBER_VERSION,
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

  it("rolls back a new record when rescan recovery shifts an ingest key", async () => {
    const stored = new Map<string, {
      readonly sourceOrdinal: number;
      readonly nativePayload: JsonValue;
    }>();
    let currentCheckpoint: NativeTranscriptCheckpointRecord | null = null;
    const batches: NativeTranscriptBatchInput[] = [];
    const ingestBatch = vi.fn(async (
      input: NativeTranscriptBatchInput,
    ): Promise<NativeTranscriptBatchResult> => {
      batches.push(input);
      const next = new Map(stored);
      for (const record of input.records) {
        const existing = next.get(record.ingestKey);
        if (
          existing
          && (
            existing.sourceOrdinal !== record.sourceOrdinal
            || canonicalNativeTranscriptJson(existing.nativePayload)
              !== canonicalNativeTranscriptJson(record.nativePayload)
          )
        ) {
          throw new Error("ingest-key provenance conflict");
        }
        next.set(record.ingestKey, {
          sourceOrdinal: record.sourceOrdinal,
          nativePayload: record.nativePayload,
        });
      }
      const previous = currentCheckpoint;
      const resultCheckpoint: NativeTranscriptCheckpointRecord = {
        projectId: "project",
        machineId: input.machineId,
        clientName: input.clientName,
        sourceLocator: input.sourceLocator,
        lastSourceOrdinal: input.checkpoint.lastSourceOrdinal,
        importedCount:
          (previous?.importedCount ?? 0) + input.records.length,
        skippedCount: previous?.skippedCount ?? 0,
        quarantinedCount:
          (previous?.quarantinedCount ?? 0) + input.quarantinedCount,
        checkpoint: input.checkpoint.checkpoint,
        updatedAt: new Date("2026-07-25T12:00:00.000Z"),
      };
      stored.clear();
      for (const [key, value] of next) stored.set(key, value);
      currentCheckpoint = resultCheckpoint;
      return {
        importedCount: input.records.length,
        skippedCount: 0,
        quarantinedCount: input.quarantinedCount,
        checkpoint: resultCheckpoint,
      };
    });
    const statefulRepository: NativeTranscriptRepository = {
      getCheckpoint: vi.fn(async () => currentCheckpoint),
      ingestBatch,
      getById: vi.fn(async () => null),
      listByNativeSession: vi.fn(async () => []),
      listBySource: vi.fn(async () => []),
      listByMessage: vi.fn(async () => []),
    };
    const quarantine = {
      clientName: "claude-code",
      quarantine: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      close: vi.fn(),
    };
    const common = {
      repository: statefulRepository,
      quarantine,
      machineId: "machine",
      format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
      nativeSessionId: "session-1",
      sourceLocator: "sessions/session.jsonl",
      messageResolver: { resolveExact: vi.fn(async () => null) },
    };
    await expect(runNativeTranscriptBackfill({
      ...common,
      source: source('{"bad":}\n{"alsoBad":}\n{"event":"same"}\n'),
    })).resolves.toMatchObject({
      importedCount: 1,
      quarantinedCount: 2,
    });
    const checkpointBeforeRecovery = currentCheckpoint;
    const retained = [...stored.values()][0];
    expect(retained).toMatchObject({
      sourceOrdinal: 2,
      nativePayload: { event: "same" },
    });

    await expect(runNativeTranscriptBackfill({
      ...common,
      source: source('{"event":"new"}\n{"event":"same"}\n'),
    })).rejects.toThrow("ingest-key provenance conflict");
    expect(batches).toHaveLength(2);
    expect(batches[1]?.records.map((record) => ({
      sourceOrdinal: record.sourceOrdinal,
      nativePayload: record.nativePayload,
    }))).toEqual([
      { sourceOrdinal: 0, nativePayload: { event: "new" } },
      { sourceOrdinal: 1, nativePayload: { event: "same" } },
    ]);
    expect(stored.size).toBe(1);
    expect([...stored.values()][0]).toEqual(retained);
    expect(currentCheckpoint).toEqual(checkpointBeforeRecovery);
  });

  it("rescans when the effective scrubber version changes", async () => {
    const content = '{"first":1}\n{"second":2}\n';
    const firstLine = '{"first":1}\n';
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
    const run = async (
      overrides: Pick<
        NativeTranscriptBackfillOptions,
        "globalPatterns" | "pipelineVersion"
      >,
    ): Promise<ReturnType<typeof repository>> => {
      const repo = repository(previous);
      await expect(runNativeTranscriptBackfill({
        repository: repo,
        quarantine: {
          clientName: "claude-code",
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
        ...overrides,
      })).resolves.toMatchObject({
        resumedFromByteOffset: 0,
        rescanned: true,
      });
      return repo;
    };

    const pipelineChanged = await run({
      globalPatterns: [],
      pipelineVersion: "pipeline/v2",
    });
    const patternsChanged = await run({
      globalPatterns: ["never-matches"],
      pipelineVersion: undefined,
    });
    expect(pipelineChanged.batches[0]?.records).toHaveLength(2);
    expect(patternsChanged.batches[0]?.records).toHaveLength(2);
    expect(
      pipelineChanged.batches.at(-1)?.checkpoint.checkpoint.scrubberVersion,
    ).not.toBe(DEFAULT_SCRUBBER_VERSION);
    expect(
      patternsChanged.batches.at(-1)?.checkpoint.checkpoint.scrubberVersion,
    ).not.toBe(DEFAULT_SCRUBBER_VERSION);

    const missingVersion = checkpoint({
      version: 1,
      byteOffset: Buffer.byteLength(firstLine),
      prefixSha256: digest(firstLine),
      source: {
        sizeBytes: Buffer.byteLength(firstLine),
        modifiedAtMs: 1,
        changedAtMs: 1,
      },
    });
    delete missingVersion.checkpoint.scrubberVersion;
    const missingRepo = repository(missingVersion);
    await expect(runNativeTranscriptBackfill({
      repository: missingRepo,
      quarantine: {
        clientName: "claude-code",
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
    })).resolves.toMatchObject({ rescanned: true });
    expect(missingRepo.batches[0]?.records).toHaveLength(2);

    const wrongTypeVersion = checkpoint({
      version: 1,
      byteOffset: Buffer.byteLength(firstLine),
      prefixSha256: digest(firstLine),
      scrubberVersion: 42,
      source: {
        sizeBytes: Buffer.byteLength(firstLine),
        modifiedAtMs: 1,
        changedAtMs: 1,
      },
    });
    const wrongTypeRepo = repository(wrongTypeVersion);
    await expect(runNativeTranscriptBackfill({
      repository: wrongTypeRepo,
      quarantine: {
        clientName: "claude-code",
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
    })).resolves.toMatchObject({ rescanned: true });
    expect(wrongTypeRepo.batches[0]?.records).toHaveLength(2);
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
    const byteSource = source(firstLine + secondLine);
    await runNativeTranscriptBackfill({
      repository: repo,
      quarantine: {
        clientName: "claude-code",
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
    const snapshot = await vi.mocked(byteSource.openSnapshot)
      .mock.results[0]!.value;
    expect(snapshot.assertByteRangesUnchanged).toHaveBeenCalledWith([{
      startByteOffset: 0,
      endByteOffset: Buffer.byteLength(firstLine),
      rangeSha256: digest(firstLine),
    }]);
    expect(snapshot.assertByteRangesUnchanged).toHaveBeenCalledWith([{
      startByteOffset: Buffer.byteLength(firstLine),
      endByteOffset: Buffer.byteLength(firstLine + secondLine),
      rangeSha256: digest(secondLine),
    }]);

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
        clientName: "claude-code",
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

  it("does not rehash a replay-only committed prefix at flush boundaries", async () => {
    const content = '{"message":{"role":"user","content":"first"}}\n';
    const previous = checkpoint({
      version: 1,
      byteOffset: Buffer.byteLength(content),
      prefixSha256: digest(content),
      source: {
        sizeBytes: Buffer.byteLength(content),
        modifiedAtMs: 1,
        changedAtMs: 1,
      },
    });
    const repo = repository(previous);
    const byteSource = source(content);
    const result = await runNativeTranscriptBackfill({
      repository: repo,
      quarantine: {
        clientName: "claude-code",
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
      messageResolver: { resolveExact: vi.fn(async () => null) },
    });
    expect(result.resumedFromByteOffset).toBe(Buffer.byteLength(content));
    expect(repo.batches).toEqual([]);
    const snapshot = await vi.mocked(byteSource.openSnapshot)
      .mock.results[0]!.value;
    expect(snapshot.digestPrefix).toHaveBeenCalledWith(
      Buffer.byteLength(content),
    );
    expect(snapshot.assertByteRangesUnchanged).not.toHaveBeenCalled();
  });

  it("owns message sequence per concurrent run when a pure mapper is reused", async () => {
    const mapper = createNativeTranscriptMessageMapper();
    const content = [
      '{"event":"ignored"}',
      '{"message":{"role":"user","content":"first"}}',
      '{"message":{"role":"assistant","content":"second"}}',
    ].join("\n");
    const run = async (nativeSessionId: string): Promise<number[]> => {
      const sequences: number[] = [];
      await runNativeTranscriptBackfill({
        repository: repository(),
        quarantine: {
          clientName: "claude-code",
          quarantine: vi.fn(),
          get: vi.fn(),
          list: vi.fn(),
          close: vi.fn(),
        },
        source: source(content),
        machineId: "machine",
        format: CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
        nativeSessionId,
        sourceLocator: `${nativeSessionId}.jsonl`,
        messageMapper: mapper,
        messageResolver: {
          resolveExact: vi.fn(async (input) => {
            sequences.push(input.sessionSequence);
            return {
              conversationId: input.sessionSequence + 1,
              messageId: input.sessionSequence + 1,
            };
          }),
        },
      });
      return sequences;
    };

    const [first, second] = await Promise.all([
      run("concurrent-1"),
      run("concurrent-2"),
    ]);
    expect(first).toEqual([0, 1]);
    expect(second).toEqual([0, 1]);
    await expect(run("reused")).resolves.toEqual([0, 1]);
  });

  it("isolates the immutable repository payload from a malicious mapper", async () => {
    const repo = repository();
    await runNativeTranscriptBackfill({
      repository: repo,
      quarantine: {
        clientName: "claude-code",
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

  it("persists new and truncated empty-source checkpoints exactly once", async () => {
    const run = async (
      repo: ReturnType<typeof repository>,
    ): Promise<{
      readonly repo: ReturnType<typeof repository>;
      readonly byteSource: NativeTranscriptByteSource;
      readonly result: NativeTranscriptBackfillResult;
    }> => {
      const byteSource = source("");
      const result = await runNativeTranscriptBackfill({
        repository: repo,
        quarantine: {
          clientName: "claude-code",
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
        messageResolver: { resolveExact: vi.fn(async () => null) },
      });
      return { repo, byteSource, result };
    };

    const created = await run(repository());
    expect(created.result).toMatchObject({ rescanned: false });
    expect(created.repo.batches).toHaveLength(1);
    expect(created.repo.batches[0]).toMatchObject({
      expectedCheckpoint: null,
      records: [],
      checkpoint: {
        lastSourceOrdinal: 0,
        checkpoint: {
          version: 1,
          byteOffset: 0,
          prefixSha256: digest(""),
          scrubberVersion: DEFAULT_SCRUBBER_VERSION,
          source: {
            sizeBytes: 0,
            modifiedAtMs: 123,
            changedAtMs: 456,
          },
        },
      },
    });
    const createdSnapshot = await vi.mocked(created.byteSource.openSnapshot)
      .mock.results[0]!.value;
    expect(createdSnapshot.assertByteRangesUnchanged).toHaveBeenCalledWith([]);
    expect(createdSnapshot.assertUnchanged).toHaveBeenCalled();

    const exactCheckpoint = checkpoint(
      created.repo.batches[0]!.checkpoint.checkpoint,
    );
    const exact = await run(repository(exactCheckpoint));
    expect(exact.result).toMatchObject({
      resumedFromByteOffset: 0,
      rescanned: false,
    });
    expect(exact.repo.batches).toHaveLength(0);

    const previous = checkpoint({
      version: 1,
      byteOffset: 12,
      prefixSha256: digest('{"old":1}\n'),
      source: {
        sizeBytes: 12,
        modifiedAtMs: 1,
        changedAtMs: 1,
      },
    });
    const truncated = await run(repository(previous));
    expect(truncated.result).toMatchObject({
      resumedFromByteOffset: 0,
      rescanned: true,
    });
    expect(truncated.repo.batches).toHaveLength(1);
    expect(truncated.repo.batches[0]?.expectedCheckpoint).toBe(previous);
    expect(truncated.repo.batches[0]?.checkpoint.checkpoint).toMatchObject({
      byteOffset: 0,
      prefixSha256: digest(""),
      scrubberVersion: DEFAULT_SCRUBBER_VERSION,
    });
  });

  it("checkpoints blank-only consumed bytes outside record accounting", async () => {
    const repo = repository();
    const content = "\n  \r\n";
    const byteSource = source(content);
    const result = await runNativeTranscriptBackfill({
      repository: repo,
      quarantine: {
        clientName: "claude-code",
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
    const snapshot = await vi.mocked(byteSource.openSnapshot)
      .mock.results[0]!.value;
    const rangeAssertion = vi.mocked(
      snapshot.assertByteRangesUnchanged,
    );
    expect(rangeAssertion).toHaveBeenCalledWith([
      {
        startByteOffset: 0,
        endByteOffset: 1,
        rangeSha256: digest("\n"),
      },
      {
        startByteOffset: 1,
        endByteOffset: Buffer.byteLength(content),
        rangeSha256: digest("  \r\n"),
      },
    ]);
    expect(rangeAssertion.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(repo.ingestBatch).mock.invocationCallOrder[0]!,
    );
  });

  it("aborts exact-link mismatches without committing the batch", async () => {
    const repo = repository();
    await expect(runNativeTranscriptBackfill({
      repository: repo,
      quarantine: {
        clientName: "claude-code",
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
        clientName: "claude-code",
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
          role: "user",
          content: "content",
          sourceOrdinal: -1,
        }],
      },
    })).rejects.toThrowError(NativeTranscriptConfigurationError);
    await expect(runNativeTranscriptBackfill({
      ...base,
      messageMapper: {
        map: () => [{
          role: "developer" as never,
          content: "content",
          sourceOrdinal: 0,
        }],
      },
    })).rejects.toThrowError(NativeTranscriptConfigurationError);
  });

  it("rejects link ordinals above PostgreSQL int4 before resolution", async () => {
    const repo = repository();
    const resolveExact = vi.fn();
    await expect(runNativeTranscriptBackfill({
      repository: repo,
      quarantine: {
        clientName: "claude-code",
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
          role: "user",
          content: "hello",
          sourceOrdinal:
            NATIVE_TRANSCRIPT_MAX_LINK_SOURCE_ORDINAL + 1,
        }],
      },
      messageResolver: { resolveExact },
    })).rejects.toThrowError(NativeTranscriptConfigurationError);
    expect(resolveExact).not.toHaveBeenCalled();
    expect(repo.ingestBatch).not.toHaveBeenCalled();
  });

  it("rejects incomplete mapping, unsafe batch, and invalid metadata", async () => {
    const repo = repository();
    const base = {
      repository: repo,
      quarantine: {
        clientName: "claude-code",
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
    const path = localTranscriptQuarantinePath(
      "project/a",
      "claude-code",
      home,
    );
    expect(path).not.toContain("project/a");
    expect(path).not.toContain("claude-code");
    const repo = openLocalTranscriptQuarantine(
      "project/a",
      "claude-code",
      home,
    );
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
    const codexPath = localTranscriptQuarantinePath(
      "project/a",
      "codex",
      home,
    );
    expect(codexPath).not.toBe(path);
    const codexRepo = openLocalTranscriptQuarantine(
      "project/a",
      "codex",
      home,
    );
    const codexRecord = await codexRepo.quarantine(input);
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
    expect(codexRecord).toMatchObject({
      quarantineId: 1,
      sourceLocator: input.sourceLocator,
      sourceOrdinal: input.sourceOrdinal,
      reason: input.reason,
      contentSha256: input.contentSha256,
    });
    expect(await codexRepo.list()).toEqual([codexRecord]);
    expect(statSync(join(home, ".lcm", "transcript-quarantine")).mode & 0o777)
      .toBe(0o700);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(lstatSync(path).isFile()).toBe(true);
    await codexRepo.close();
    await repo.close();
    await repo.close();
    await expect(repo.list()).rejects.toMatchObject({
      code: "STORAGE_CLOSED",
    });
  });

  it("rejects invalid metadata, limits, closed access, and symlink leaves", async () => {
    const home = temporaryDirectory();
    expect(() =>
      localTranscriptQuarantinePath("project", "unknown", home)
    ).toThrowError(expect.objectContaining({
      code: "STORAGE_OPERATION_FAILED",
    }));
    const repo = openLocalTranscriptQuarantine("project", "codex", home);
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
    const path = localTranscriptQuarantinePath("symlink", "codex", home);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync("/dev/null", path);
    expect(() => openLocalTranscriptQuarantine("symlink", "codex", home))
      .toThrow("symlink");
  });

  it("migrates the unreleased quarantine schema without losing metadata", async () => {
    const home = temporaryDirectory();
    const path = localTranscriptQuarantinePath(
      "legacy-project",
      "claude-code",
      home,
    );
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
      "claude-code",
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

    const reopened = openLocalTranscriptQuarantine(
      "legacy-project",
      "claude-code",
      home,
    );
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
      "claude-code",
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
      "claude-code",
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
      "claude-code",
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
      "claude-code",
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
      "claude-code",
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
