import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { GITLEAKS_PATTERNS } from "../generated-patterns.js";
import { NATIVE_PATTERNS, ScrubEngine } from "../scrub.js";
import type { MessageRole } from "../store/conversation-store.js";
import type {
  CreateNativeTranscriptInput,
  CreateNativeTranscriptMessageLinkInput,
  JsonObject,
  JsonValue,
  NativeTranscriptCheckpointRecord,
  NativeTranscriptMessageSnapshotRepository,
  NativeTranscriptRepository,
} from "./contracts.js";
import { NATIVE_TRANSCRIPT_MAX_JSON_DEPTH } from "./contracts.js";
import type {
  LocalTranscriptQuarantineRepository,
  TranscriptQuarantineReason,
} from "./local-transcript-quarantine.js";

export interface NativeTranscriptFormat {
  readonly clientName: "claude-code" | "codex";
  readonly formatName: "claude-jsonl" | "codex-jsonl";
  readonly formatVersion: "v1";
}

export const CLAUDE_NATIVE_TRANSCRIPT_FORMAT = {
  clientName: "claude-code",
  formatName: "claude-jsonl",
  formatVersion: "v1",
} as const satisfies NativeTranscriptFormat;

export const CODEX_NATIVE_TRANSCRIPT_FORMAT = {
  clientName: "codex",
  formatName: "codex-jsonl",
  formatVersion: "v1",
} as const satisfies NativeTranscriptFormat;

export const SUPPORTED_NATIVE_TRANSCRIPT_FORMATS = [
  CLAUDE_NATIVE_TRANSCRIPT_FORMAT,
  CODEX_NATIVE_TRANSCRIPT_FORMAT,
] as const;

export const NATIVE_TRANSCRIPT_MAX_RECORD_BYTES = 10 * 1024 * 1024;
export const NATIVE_TRANSCRIPT_DEFAULT_BATCH_SIZE = 100;
export const NATIVE_TRANSCRIPT_MAX_BATCH_SIZE = 1_000;
export const NATIVE_TRANSCRIPT_SCRUB_PIPELINE_VERSION =
  "native-json-scrub/v1";

const PROTECTED_NATIVE_TRANSCRIPT_MARKERS = [
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
] as const;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^(?:[a-zA-Z]:|[\\/])/u;
const CHECKPOINT_VERSION = 1;

export class NativeTranscriptConfigurationError extends Error {
  constructor(readonly code: "invalid-patterns" | "invalid-input") {
    super(`native transcript configuration failed: ${code}`);
    this.name = "NativeTranscriptConfigurationError";
  }
}

export class NativeTranscriptLinkError extends Error {
  constructor(readonly sourceOrdinal: number) {
    super("native transcript message linkage failed");
    this.name = "NativeTranscriptLinkError";
  }
}

class NativeTranscriptRecordError extends Error {
  constructor(readonly reason: TranscriptQuarantineReason) {
    super("native transcript record validation failed");
    this.name = "NativeTranscriptRecordError";
  }
}

export interface NativeTranscriptScrubber {
  readonly scrubberVersion: string;
  scrubJson(value: JsonObject | JsonValue[]): JsonObject | JsonValue[];
}

export interface NativeTranscriptScrubberOptions {
  readonly globalPatterns: readonly string[];
  readonly projectPatterns: readonly string[];
  readonly pipelineVersion?: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function effectivePatternDigest(
  globalPatterns: readonly string[],
  projectPatterns: readonly string[],
): string {
  return sha256(JSON.stringify({
    gitleaks: GITLEAKS_PATTERNS.map(({ regex, flags }) => [regex, flags]),
    native: NATIVE_PATTERNS,
    global: globalPatterns,
    project: projectPatterns,
  }));
}

function assertNoNul(value: string): void {
  if (value.includes("\0")) {
    throw new NativeTranscriptRecordError("nul-character");
  }
}

function scrubString(engine: ScrubEngine, value: string): string {
  assertUnicodeScalarValue(value);
  assertNoNul(value);
  const scrubbed = engine.scrub(value);
  assertUnicodeScalarValue(scrubbed);
  assertNoNul(scrubbed);
  if (engine.scrub(scrubbed) !== scrubbed) {
    throw new NativeTranscriptRecordError("residual-secret");
  }
  return scrubbed;
}

function scrubJsonValue(engine: ScrubEngine, value: JsonValue): JsonValue {
  if (typeof value === "string") return scrubString(engine, value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => scrubJsonValue(engine, item));
  }
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const scrubbedKey = scrubString(engine, key);
    if (Object.hasOwn(result, scrubbedKey)) {
      throw new NativeTranscriptRecordError("redacted-key-collision");
    }
    Object.defineProperty(result, scrubbedKey, {
      configurable: true,
      enumerable: true,
      value: scrubJsonValue(engine, item),
      writable: true,
    });
  }
  return result;
}

function assertMapperMarkersPreserved(engine: ScrubEngine): void {
  for (const marker of PROTECTED_NATIVE_TRANSCRIPT_MARKERS) {
    const encodedMarker = JSON.stringify(marker);
    if (
      engine.scrub(marker) !== marker
      || !engine.scrub(`{${encodedMarker}:null}`).includes(encodedMarker)
      || !engine.scrub(`{"_":${encodedMarker}}`).includes(encodedMarker)
    ) {
      throw new NativeTranscriptConfigurationError("invalid-patterns");
    }
  }
  const mapperShapeProbes = [
    ...["user", "assistant", "system"].map((role) =>
      JSON.stringify({
        message: {
          role,
          content: [
            { type: "text", text: "text" },
            { type: "tool_result", content: "content" },
          ],
        },
      })),
    ...["user", "assistant"].map((role) =>
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role,
          content: [
            { type: "input_text", text: "text" },
            { type: "output_text", text: "text" },
            { type: "text", text: "text" },
          ],
        },
      })),
  ];
  if (mapperShapeProbes.some((probe) => engine.scrub(probe) !== probe)) {
    throw new NativeTranscriptConfigurationError("invalid-patterns");
  }
}

export function createNativeTranscriptScrubber(
  options: NativeTranscriptScrubberOptions,
): NativeTranscriptScrubber {
  if (
    !Array.isArray(options?.globalPatterns)
    || !Array.isArray(options.projectPatterns)
    || options.globalPatterns.some((pattern) => typeof pattern !== "string")
    || options.projectPatterns.some((pattern) => typeof pattern !== "string")
  ) {
    throw new NativeTranscriptConfigurationError("invalid-input");
  }
  const globalPatterns = [...options.globalPatterns];
  const projectPatterns = [...options.projectPatterns];
  const pipelineVersion =
    options.pipelineVersion ?? NATIVE_TRANSCRIPT_SCRUB_PIPELINE_VERSION;
  if (pipelineVersion.trim().length === 0 || pipelineVersion.includes("\0")) {
    throw new NativeTranscriptConfigurationError("invalid-input");
  }
  const engine = new ScrubEngine(globalPatterns, projectPatterns);
  if (engine.invalidPatterns.length > 0) {
    throw new NativeTranscriptConfigurationError("invalid-patterns");
  }
  assertMapperMarkersPreserved(engine);
  const scrubberVersion = `${pipelineVersion}:${effectivePatternDigest(
    globalPatterns,
    projectPatterns,
  )}`;
  return {
    scrubberVersion,
    scrubJson: (value): JsonObject | JsonValue[] => {
      const scrubbed = scrubJsonValue(
        engine,
        value,
      ) as JsonObject | JsonValue[];
      const canonical = canonicalNativeTranscriptJson(scrubbed);
      if (engine.scrub(canonical) !== canonical) {
        throw new NativeTranscriptRecordError("residual-secret");
      }
      return scrubbed;
    },
  };
}

export function canonicalNativeTranscriptJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalNativeTranscriptJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) =>
      `${JSON.stringify(key)}:${canonicalNativeTranscriptJson(value[key])}`)
    .join(",")}}`;
}

function assertFormat(format: NativeTranscriptFormat): void {
  const supported = SUPPORTED_NATIVE_TRANSCRIPT_FORMATS.some(
    (candidate) =>
      candidate.clientName === format.clientName
      && candidate.formatName === format.formatName
      && candidate.formatVersion === format.formatVersion,
  );
  if (!supported) throw new NativeTranscriptConfigurationError("invalid-input");
}

function assertNonemptyText(value: string): void {
  if (value.length === 0 || value.includes("\0")) {
    throw new NativeTranscriptConfigurationError("invalid-input");
  }
}

function assertSourceLocator(value: string): void {
  assertNonemptyText(value);
  if (
    isAbsolute(value)
    || WINDOWS_ABSOLUTE_PATH_PATTERN.test(value)
    || value.split(/[\\/]/u).includes("..")
  ) {
    throw new NativeTranscriptConfigurationError("invalid-input");
  }
}

function assertSafeNonnegative(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new NativeTranscriptConfigurationError("invalid-input");
  }
}

export interface PreparedNativeTranscriptRecord {
  readonly kind: "record";
  readonly sourceOrdinal: number;
  readonly endByteOffset: number;
  readonly prefixSha256: string;
  readonly formatName: NativeTranscriptFormat["formatName"];
  readonly formatVersion: NativeTranscriptFormat["formatVersion"];
  readonly nativeSessionId: string;
  readonly observedAt: Date;
  readonly scrubberVersion: string;
  readonly contentSha256: string;
  readonly ingestKey: string;
  readonly nativePayload: JsonObject | JsonValue[];
}

export interface QuarantinedNativeTranscriptRecord {
  readonly kind: "quarantine";
  readonly sourceOrdinal: number;
  readonly endByteOffset: number;
  readonly prefixSha256: string;
  readonly reason: TranscriptQuarantineReason;
  readonly contentSha256: string;
  readonly quarantinedAt: Date;
}

export type NativeTranscriptReadOutcome =
  | PreparedNativeTranscriptRecord
  | QuarantinedNativeTranscriptRecord;

export interface NativeTranscriptJsonlReadOptions {
  readonly bytes: AsyncIterable<Uint8Array>;
  readonly format: NativeTranscriptFormat;
  readonly nativeSessionId: string;
  readonly sourceLocator: string;
  readonly scrubber: NativeTranscriptScrubber;
  readonly clock?: () => Date;
  /** @internal Allows bounded unit tests without allocating ten MiB. */
  readonly maxRecordBytes?: number;
  /**
   * Report physical progress only after this absolute byte boundary.
   * Crossing records are trimmed and rehashed from the boundary.
   */
  readonly progressStartByteOffset?: number;
  /** Reports consumed record or blank-line boundaries without payload data. */
  readonly onProgress?: (progress: {
    readonly startByteOffset: number;
    readonly endByteOffset: number;
    readonly rangeSha256: string;
    readonly prefixSha256: string;
  }) => void;
}

function ingestKey(
  format: NativeTranscriptFormat,
  nativeSessionId: string,
  sourceLocator: string,
  contentSha256: string,
  occurrence: number,
): string {
  return sha256(JSON.stringify([
    format.clientName,
    format.formatName,
    format.formatVersion,
    nativeSessionId,
    sourceLocator,
    contentSha256,
    occurrence,
  ]));
}

const JSON_NUMBER_TOKEN_PATTERN =
  /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/uy;

type CanonicalDecimal = {
  readonly negative: boolean;
  readonly coefficient: string;
  readonly exponent: number;
};

function canonicalDecimal(token: string): CanonicalDecimal | null {
  let cursor = token.startsWith("-") ? 1 : 0;
  const negative = cursor === 1;
  const exponentMarker = token.slice(cursor).search(/[eE]/u);
  const significandEnd = exponentMarker < 0
    ? token.length
    : cursor + exponentMarker;
  const significand = token.slice(cursor, significandEnd);
  const decimalPoint = significand.indexOf(".");
  const fractionalLength = decimalPoint < 0
    ? 0
    : significand.length - decimalPoint - 1;
  let coefficient = significand.replace(".", "").replace(/^0+/u, "");
  if (coefficient.length === 0) {
    return { negative: false, coefficient: "0", exponent: 0 };
  }
  let coefficientEnd = coefficient.length;
  while (
    coefficientEnd > 0 &&
    coefficient.charCodeAt(coefficientEnd - 1) === 0x30
  ) {
    coefficientEnd -= 1;
  }
  const trailingZeroCount = coefficient.length - coefficientEnd;
  coefficient = coefficient.slice(0, coefficientEnd);
  let explicitExponent = 0;
  if (exponentMarker >= 0) {
    const exponentText = token.slice(significandEnd + 1);
    const unsignedExponent = exponentText.replace(/^[+-]/u, "")
      .replace(/^0+/u, "");
    if (unsignedExponent.length > 16) return null;
    explicitExponent = Number(exponentText);
    if (!Number.isSafeInteger(explicitExponent)) return null;
  }
  const exponent =
    explicitExponent - fractionalLength + trailingZeroCount;
  return { negative, coefficient, exponent };
}

function assertLosslessJsonNumbers(text: string): void {
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      if (character === "\\") {
        index += 1;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character !== "-" && (character < "0" || character > "9")) {
      continue;
    }
    JSON_NUMBER_TOKEN_PATTERN.lastIndex = index;
    const match = JSON_NUMBER_TOKEN_PATTERN.exec(text);
    if (!match) continue;
    const token = match[0];
    const parsed = Number(token);
    const originalDecimal = canonicalDecimal(token);
    const roundTrippedDecimal = Number.isFinite(parsed)
      ? canonicalDecimal(parsed.toString())
      : null;
    if (
      !originalDecimal
      || !roundTrippedDecimal
      || originalDecimal.negative !== roundTrippedDecimal.negative
      || originalDecimal.coefficient !== roundTrippedDecimal.coefficient
      || originalDecimal.exponent !== roundTrippedDecimal.exponent
    ) {
      throw new NativeTranscriptRecordError("malformed-json");
    }
    index = JSON_NUMBER_TOKEN_PATTERN.lastIndex - 1;
  }
}

function assertUniqueJsonObjectKeys(text: string): void {
  const containers: Array<{
    readonly kind: "array" | "object";
    readonly keys?: Set<string>;
  }> = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "{") {
      containers.push({ kind: "object", keys: new Set() });
      continue;
    }
    if (character === "[") {
      containers.push({ kind: "array" });
      continue;
    }
    if (character === "}" || character === "]") {
      containers.pop();
      continue;
    }
    if (character !== '"') continue;
    const start = index;
    for (index += 1; index < text.length; index += 1) {
      if (text[index] === "\\") {
        index += 1;
      } else if (text[index] === '"') {
        break;
      }
    }
    const token = text.slice(start, index + 1);
    let following = index + 1;
    while (following < text.length && /\s/u.test(text[following]!)) {
      following += 1;
    }
    const container = containers.at(-1);
    if (container?.kind !== "object" || text[following] !== ":") continue;
    let key: unknown;
    try {
      key = JSON.parse(token);
    } catch {
      throw new NativeTranscriptRecordError("malformed-json");
    }
    if (typeof key !== "string" || container.keys!.has(key)) {
      throw new NativeTranscriptRecordError("malformed-json");
    }
    container.keys!.add(key);
  }
}

function parsedContainer(text: string): JsonObject | JsonValue[] {
  let parsed: JsonValue;
  try {
    assertUniqueJsonObjectKeys(text);
    assertLosslessJsonNumbers(text);
    parsed = JSON.parse(text) as JsonValue;
  } catch {
    throw new NativeTranscriptRecordError("malformed-json");
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new NativeTranscriptRecordError("non-container-json");
  }
  return parsed as JsonObject | JsonValue[];
}

function assertUnicodeScalarValue(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new NativeTranscriptRecordError("malformed-json");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new NativeTranscriptRecordError("malformed-json");
    }
  }
}

function assertJsonTreeSafe(root: JsonObject | JsonValue[]): void {
  const pending: Array<{ value: JsonValue; depth: number }> = [{
    value: root,
    depth: 1,
  }];
  while (pending.length > 0) {
    const candidate = pending.pop()!;
    if (typeof candidate.value === "string") {
      assertUnicodeScalarValue(candidate.value);
    }
    if (
      candidate.value === null
      || typeof candidate.value !== "object"
    ) {
      continue;
    }
    if (candidate.depth > NATIVE_TRANSCRIPT_MAX_JSON_DEPTH) {
      throw new NativeTranscriptRecordError("nesting-too-deep");
    }
    const children = Array.isArray(candidate.value)
      ? candidate.value
      : Object.entries(candidate.value).map(([key, value]) => {
          assertUnicodeScalarValue(key);
          return value;
        });
    for (const value of children) {
      pending.push({ value, depth: candidate.depth + 1 });
    }
  }
}

function decodeRecord(bytes: Uint8Array): string {
  if (bytes.includes(0)) {
    throw new NativeTranscriptRecordError("binary-input");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new NativeTranscriptRecordError("invalid-utf8");
  }
}

type RecordAccumulator = {
  readonly parts: Buffer[];
  readonly rawHash: ReturnType<typeof createHash>;
  byteLength: number;
  oversized: boolean;
};

function newAccumulator(): RecordAccumulator {
  return {
    parts: [],
    rawHash: createHash("sha256"),
    byteLength: 0,
    oversized: false,
  };
}

function appendRecordBytes(
  accumulator: RecordAccumulator,
  bytes: Uint8Array,
  maxRecordBytes: number,
): void {
  accumulator.rawHash.update(bytes);
  accumulator.byteLength += bytes.byteLength;
  if (accumulator.oversized) return;
  if (accumulator.byteLength > maxRecordBytes) {
    accumulator.oversized = true;
    accumulator.parts.length = 0;
    return;
  }
  if (bytes.byteLength > 0) accumulator.parts.push(Buffer.from(bytes));
}

function accumulatedBytes(accumulator: RecordAccumulator): Buffer {
  const bytes = Buffer.concat(accumulator.parts, accumulator.byteLength);
  return bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes;
}

function isJsonlBlank(bytes: Uint8Array): boolean {
  return bytes.every((byte) =>
    byte === 0x09 || byte === 0x0d || byte === 0x20);
}

function quarantineOutcome(
  sourceOrdinal: number,
  endByteOffset: number,
  prefixSha256: string,
  reason: TranscriptQuarantineReason,
  contentSha256: string,
  clock: () => Date,
): QuarantinedNativeTranscriptRecord {
  const quarantinedAt = clock();
  if (!Number.isFinite(quarantinedAt.getTime())) {
    throw new NativeTranscriptConfigurationError("invalid-input");
  }
  return {
    kind: "quarantine",
    sourceOrdinal,
    endByteOffset,
    prefixSha256,
    reason,
    contentSha256,
    quarantinedAt,
  };
}

export async function* readNativeTranscriptJsonl(
  options: NativeTranscriptJsonlReadOptions,
): AsyncGenerator<NativeTranscriptReadOutcome> {
  assertFormat(options.format);
  assertNonemptyText(options.nativeSessionId);
  assertSourceLocator(options.sourceLocator);
  const maxRecordBytes =
    options.maxRecordBytes ?? NATIVE_TRANSCRIPT_MAX_RECORD_BYTES;
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) {
    throw new NativeTranscriptConfigurationError("invalid-input");
  }
  const progressStartByteOffset = options.progressStartByteOffset ?? 0;
  if (
    !Number.isSafeInteger(progressStartByteOffset)
    || progressStartByteOffset < 0
  ) {
    throw new NativeTranscriptConfigurationError("invalid-input");
  }
  const clock = options.clock ?? (() => new Date());
  const prefixHash = createHash("sha256");
  const occurrences = new Map<string, number>();
  let accumulator = newAccumulator();
  let sourceOrdinal = 0;
  let byteOffset = 0;
  let recordStartByteOffset = 0;
  let progressRangeHash = createHash("sha256");

  const trackProgressBytes = (
    bytes: Uint8Array,
    startByteOffset: number,
  ): void => {
    const relativeStart = Math.max(
      0,
      progressStartByteOffset - startByteOffset,
    );
    if (relativeStart < bytes.byteLength) {
      progressRangeHash.update(bytes.subarray(relativeStart));
    }
  };

  const finishRecord = (
    endByteOffset: number,
  ): NativeTranscriptReadOutcome | null => {
    const prefixSha256 = prefixHash.copy().digest("hex");
    if (endByteOffset > progressStartByteOffset) {
      options.onProgress?.({
        startByteOffset: Math.max(
          recordStartByteOffset,
          progressStartByteOffset,
        ),
        endByteOffset,
        rangeSha256: progressRangeHash.digest("hex"),
        prefixSha256,
      });
    }
    if (accumulator.oversized) {
      const outcome = quarantineOutcome(
        sourceOrdinal,
        endByteOffset,
        prefixSha256,
        "record-too-large",
        accumulator.rawHash.copy().digest("hex"),
        clock,
      );
      sourceOrdinal += 1;
      return outcome;
    }
    const bytes = accumulatedBytes(accumulator);
    if (isJsonlBlank(bytes)) return null;
    const rawDigest = accumulator.rawHash.copy().digest("hex");
    try {
      const parsed = parsedContainer(decodeRecord(bytes));
      assertJsonTreeSafe(parsed);
      const nativePayload = options.scrubber.scrubJson(parsed);
      const contentSha256 = sha256(
        canonicalNativeTranscriptJson(nativePayload),
      );
      const occurrence = (occurrences.get(contentSha256) ?? 0) + 1;
      occurrences.set(contentSha256, occurrence);
      const observedAt = clock();
      if (!Number.isFinite(observedAt.getTime())) {
        throw new NativeTranscriptConfigurationError("invalid-input");
      }
      const outcome: PreparedNativeTranscriptRecord = {
        kind: "record",
        sourceOrdinal,
        endByteOffset,
        prefixSha256,
        formatName: options.format.formatName,
        formatVersion: options.format.formatVersion,
        nativeSessionId: options.nativeSessionId,
        observedAt,
        scrubberVersion: options.scrubber.scrubberVersion,
        contentSha256,
        ingestKey: ingestKey(
          options.format,
          options.nativeSessionId,
          options.sourceLocator,
          contentSha256,
          occurrence,
        ),
        nativePayload,
      };
      sourceOrdinal += 1;
      return outcome;
    } catch (error) {
      if (!(error instanceof NativeTranscriptRecordError)) throw error;
      const outcome = quarantineOutcome(
        sourceOrdinal,
        endByteOffset,
        prefixSha256,
        error.reason,
        rawDigest,
        clock,
      );
      sourceOrdinal += 1;
      return outcome;
    }
  };

  for await (const chunk of options.bytes) {
    if (!(chunk instanceof Uint8Array)) {
      throw new NativeTranscriptConfigurationError("invalid-input");
    }
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      const segment = chunk.subarray(start, index);
      trackProgressBytes(segment, byteOffset);
      appendRecordBytes(accumulator, segment, maxRecordBytes);
      prefixHash.update(segment);
      trackProgressBytes(Uint8Array.of(0x0a), byteOffset + segment.byteLength);
      prefixHash.update(Uint8Array.of(0x0a));
      byteOffset += segment.byteLength + 1;
      const outcome = finishRecord(byteOffset);
      accumulator = newAccumulator();
      progressRangeHash = createHash("sha256");
      recordStartByteOffset = byteOffset;
      if (outcome) yield outcome;
      start = index + 1;
    }
    const remainder = chunk.subarray(start);
    trackProgressBytes(remainder, byteOffset);
    appendRecordBytes(accumulator, remainder, maxRecordBytes);
    prefixHash.update(remainder);
    byteOffset += remainder.byteLength;
  }
  if (accumulator.byteLength > 0) {
    const outcome = finishRecord(byteOffset);
    if (outcome) yield outcome;
  }
}

export interface NativeTranscriptSourceMetadata {
  readonly sizeBytes: number;
  readonly modifiedAtMs: number;
  /** Descriptor ctime change cookie used only for in-run mutation fencing. */
  readonly changedAtMs: number;
}

export interface NativeTranscriptByteRangeDigest {
  readonly startByteOffset: number;
  readonly endByteOffset: number;
  readonly rangeSha256: string;
}

export interface NativeTranscriptSourceSnapshot {
  readonly metadata: NativeTranscriptSourceMetadata;
  digestPrefix(byteLength: number): Promise<string>;
  stream(): AsyncIterable<Uint8Array>;
  assertByteRangesUnchanged(
    ranges: readonly NativeTranscriptByteRangeDigest[],
  ): Promise<void>;
  assertUnchanged(): Promise<void>;
  close(): Promise<void>;
}

export interface NativeTranscriptByteSource {
  openSnapshot(): Promise<NativeTranscriptSourceSnapshot>;
}

export class NativeTranscriptSourceChangedError extends Error {
  constructor() {
    super("native transcript source changed during backfill");
    this.name = "NativeTranscriptSourceChangedError";
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(prefix);
}

function openValidatedSourceFile(
  rootPath: string,
  sourcePath: string,
  afterOpen?: () => void,
): {
  fd: number;
  device: bigint;
  inode: bigint;
  mode: bigint;
  userId: bigint;
  groupId: bigint;
  sizeBytes: number;
  sizeBytesExact: bigint;
  modifiedAtMs: number;
  modifiedAtNs: bigint;
  changedAtMs: number;
  changedAtNs: bigint;
} {
  const realRoot = realpathSync(rootPath);
  const realParent = realpathSync(dirname(sourcePath));
  if (!isContainedPath(realRoot, realParent)) {
    throw new NativeTranscriptConfigurationError("invalid-input");
  }
  const fd = openSync(
    sourcePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const descriptorStat = fstatSync(fd, { bigint: true });
    if (!descriptorStat.isFile()) {
      throw new NativeTranscriptConfigurationError("invalid-input");
    }
    const sizeBytes = Number(descriptorStat.size);
    assertSafeNonnegative(sizeBytes);
    afterOpen?.();
    const openedPath = realpathSync(sourcePath);
    const currentStat = statSync(openedPath, { bigint: true });
    if (
      !isContainedPath(realRoot, openedPath)
      || currentStat.dev !== descriptorStat.dev
      || currentStat.ino !== descriptorStat.ino
    ) {
      throw new NativeTranscriptConfigurationError("invalid-input");
    }
    return {
      fd,
      device: descriptorStat.dev,
      inode: descriptorStat.ino,
      mode: descriptorStat.mode,
      userId: descriptorStat.uid,
      groupId: descriptorStat.gid,
      sizeBytes,
      sizeBytesExact: descriptorStat.size,
      modifiedAtMs: Number(descriptorStat.mtimeNs) / 1_000_000,
      modifiedAtNs: descriptorStat.mtimeNs,
      changedAtMs: Number(descriptorStat.ctimeNs) / 1_000_000,
      changedAtNs: descriptorStat.ctimeNs,
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function createFileNativeTranscriptSource(
  clientRoot: string,
  sourceLocator: string,
  options: {
    /** @internal Deterministic streaming seam for unit tests. */
    readonly chunkBytes?: number;
    /** @internal Deterministic descriptor-race seam for unit tests. */
    readonly _afterOpenForTesting?: () => void;
    /** @internal Runs after the bound snapshot has been created. */
    readonly _afterSnapshotOpenForTesting?: () => void;
    /** @internal Deterministic prefix-verification mutation seam. */
    readonly _beforeDigestPrefixForTesting?: () => void;
    /** @internal Deterministic pre-stream mutation seam. */
    readonly _beforeStreamForTesting?: () => void;
    /** @internal Deterministic mid-stream mutation seam. */
    readonly _afterChunkForTesting?: (chunkOrdinal: number) => void;
    /** @internal Simulates filesystem change-cookie coalescing. */
    readonly _forceMetadataUnchangedForTesting?: boolean;
  } = {},
): NativeTranscriptByteSource {
  assertSourceLocator(sourceLocator);
  const chunkBytes = options.chunkBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
    throw new NativeTranscriptConfigurationError("invalid-input");
  }
  const sourcePath = join(clientRoot, sourceLocator);
  return {
    openSnapshot: async (): Promise<NativeTranscriptSourceSnapshot> => {
      const opened = openValidatedSourceFile(
        clientRoot,
        sourcePath,
        options._afterOpenForTesting,
      );
      let closed = false;
      const metadata = {
        sizeBytes: opened.sizeBytes,
        modifiedAtMs: opened.modifiedAtMs,
        changedAtMs: opened.changedAtMs,
      };
      const assertOpen = (): void => {
        if (closed) {
          throw new NativeTranscriptConfigurationError("invalid-input");
        }
      };
      const assertUnchanged = (): void => {
        assertOpen();
        if (options._forceMetadataUnchangedForTesting) return;
        const current = fstatSync(opened.fd, { bigint: true });
        const descriptorChanged =
          current.dev !== opened.device
          || current.ino !== opened.inode
          || current.mode !== opened.mode
          || current.uid !== opened.userId
          || current.gid !== opened.groupId
          || current.size !== opened.sizeBytesExact
          || current.mtimeNs !== opened.modifiedAtNs;
        if (descriptorChanged) {
          throw new NativeTranscriptSourceChangedError();
        }
        if (current.ctimeNs !== opened.changedAtNs) {
          let locatorStillNamesOpenedFile = true;
          try {
            const locatorStat = statSync(sourcePath, { bigint: true });
            locatorStillNamesOpenedFile =
              locatorStat.dev === opened.device
              && locatorStat.ino === opened.inode;
          } catch {
            // A missing or unreadable locator does not prove atomic replacement.
          }
          if (locatorStillNamesOpenedFile) {
            throw new NativeTranscriptSourceChangedError();
          }
        }
      };
      const snapshot: NativeTranscriptSourceSnapshot = {
        metadata,
        assertUnchanged: async (): Promise<void> => assertUnchanged(),
        assertByteRangesUnchanged: async (
          ranges,
        ): Promise<void> => {
          assertOpen();
          let previousEnd: number | undefined;
          const buffer = Buffer.allocUnsafe(chunkBytes);
          for (const range of ranges) {
            assertSafeNonnegative(range.startByteOffset);
            assertSafeNonnegative(range.endByteOffset);
            if (
              range.endByteOffset <= range.startByteOffset
              || range.endByteOffset > opened.sizeBytes
              || !DIGEST_PATTERN.test(range.rangeSha256)
              || (
                previousEnd !== undefined
                && range.startByteOffset !== previousEnd
              )
            ) {
              throw new NativeTranscriptConfigurationError("invalid-input");
            }
            const hash = createHash("sha256");
            let position = range.startByteOffset;
            while (position < range.endByteOffset) {
              const bytesRead = readSync(
                opened.fd,
                buffer,
                0,
                Math.min(buffer.byteLength, range.endByteOffset - position),
                position,
              );
              if (bytesRead === 0) {
                throw new NativeTranscriptSourceChangedError();
              }
              hash.update(buffer.subarray(0, bytesRead));
              position += bytesRead;
            }
            if (hash.digest("hex") !== range.rangeSha256) {
              throw new NativeTranscriptSourceChangedError();
            }
            previousEnd = range.endByteOffset;
          }
        },
        digestPrefix: async (byteLength: number): Promise<string> => {
          assertOpen();
          assertSafeNonnegative(byteLength);
          options._beforeDigestPrefixForTesting?.();
          if (byteLength > opened.sizeBytes) {
            throw new NativeTranscriptConfigurationError("invalid-input");
          }
          const hash = createHash("sha256");
          const buffer = Buffer.allocUnsafe(
            Math.max(1, Math.min(chunkBytes, byteLength)),
          );
          let remaining = byteLength;
          let position = 0;
          while (remaining > 0) {
            const bytesRead = readSync(
              opened.fd,
              buffer,
              0,
              Math.min(buffer.byteLength, remaining),
              position,
            );
            if (bytesRead === 0) {
              throw new NativeTranscriptSourceChangedError();
            }
            hash.update(buffer.subarray(0, bytesRead));
            remaining -= bytesRead;
            position += bytesRead;
          }
          return hash.digest("hex");
        },
        stream: async function* (): AsyncGenerator<Uint8Array> {
          assertOpen();
          options._beforeStreamForTesting?.();
          const buffer = Buffer.allocUnsafe(chunkBytes);
          let position = 0;
          let chunkOrdinal = 0;
          while (position < opened.sizeBytes) {
            const bytesRead = readSync(
              opened.fd,
              buffer,
              0,
              Math.min(buffer.byteLength, opened.sizeBytes - position),
              position,
            );
            if (bytesRead === 0) {
              throw new NativeTranscriptSourceChangedError();
            }
            position += bytesRead;
            const chunk = Buffer.from(buffer.subarray(0, bytesRead));
            options._afterChunkForTesting?.(chunkOrdinal);
            chunkOrdinal += 1;
            yield chunk;
          }
        },
        close: async (): Promise<void> => {
          if (closed) return;
          closed = true;
          closeSync(opened.fd);
        },
      };
      try {
        options._afterSnapshotOpenForTesting?.();
        return snapshot;
      } catch (error) {
        await snapshot.close();
        throw error;
      }
    },
  };
}

export interface NativeTranscriptMessageCandidate {
  readonly role: MessageRole;
  readonly content: string;
  readonly sourceOrdinal: number;
}

export interface NativeTranscriptMessageMapper {
  map(
    format: NativeTranscriptFormat,
    payload: JsonObject | JsonValue[],
    sourceOrdinal: number,
  ): readonly NativeTranscriptMessageCandidate[];
}

const MESSAGE_ROLES = new Set<MessageRole>([
  "system",
  "user",
  "assistant",
  "tool",
]);

function isMessageRole(value: unknown): value is MessageRole {
  return typeof value === "string"
    && MESSAGE_ROLES.has(value as MessageRole);
}

function object(value: JsonValue | undefined): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: cloneJsonValue(item),
      writable: true,
    });
  }
  return result;
}

function cloneNativePayload(
  value: JsonObject | JsonValue[],
): JsonObject | JsonValue[] {
  return cloneJsonValue(value) as JsonObject | JsonValue[];
}

function claudeText(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    const block = object(item);
    if (!block) return "";
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
    return block.type === "tool_result"
      ? claudeText(block.content)
      : "";
  }).filter(Boolean).join("\n");
}

function codexText(value: JsonValue | undefined): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    const block = object(item);
    if (
      block
      && (
        block.type === "input_text"
        || block.type === "output_text"
        || block.type === "text"
      )
      && typeof block.text === "string"
    ) {
      return block.text;
    }
    return "";
  }).filter(Boolean).join("\n").trim();
}

/**
 * Maps the supported sanitized client-native message records exactly as the
 * existing #85 Claude and Codex transcript parsers do.
 */
export function createNativeTranscriptMessageMapper():
  NativeTranscriptMessageMapper {
  return {
    map: (
      format,
      payload,
      sourceOrdinal,
    ): readonly NativeTranscriptMessageCandidate[] => {
      const root = object(payload);
      if (!root) return [];
      let role: JsonValue | undefined;
      let content = "";
      if (format.clientName === "claude-code") {
        const message = object(root.message);
        role = message?.role;
        if (
          role !== "user"
          && role !== "assistant"
          && role !== "system"
        ) {
          return [];
        }
        content = claudeText(message?.content);
      } else {
        if (root.type !== "response_item") return [];
        const message = object(root.payload);
        if (message?.type !== "message") return [];
        role = message.role;
        if (role !== "user" && role !== "assistant") return [];
        content = codexText(message.content);
      }
      if (content.trim().length === 0) return [];
      const candidate: NativeTranscriptMessageCandidate = {
        role,
        content,
        sourceOrdinal,
      };
      return [candidate];
    },
  };
}

export interface ExactNativeTranscriptMessageResolver {
  resolveExact(input: {
    readonly nativeSessionId: string;
    readonly sessionSequence: number;
    readonly role: MessageRole;
    readonly content: string;
  }): Promise<{
    readonly conversationId: number;
    readonly messageId: number;
  } | null>;
}

/**
 * Resolve one sanitized native message against the exact #85 session-wide
 * message order without wiring transcript backfill into normal daemon or CLI
 * ingestion.
 *
 * Create one resolver per backfill. It materializes and caches one immutable
 * repository snapshot per native session so records in the same source cannot
 * observe different destination views.
 *
 * A session can span multiple conversations. Conversations are ordered by
 * creation time and then conversation ID, while each conversation must expose
 * a contiguous zero-based message sequence. This makes the session-wide order
 * deterministic and fails closed on inconsistent repository data.
 */
export function createExactNativeTranscriptMessageResolver(
  messages: NativeTranscriptMessageSnapshotRepository,
): ExactNativeTranscriptMessageResolver {
  type ResolvedMessage = {
    readonly conversationId: number;
    readonly messageId: number;
    readonly role: MessageRole;
    readonly content: string;
  };
  const snapshots = new Map<string, Promise<readonly ResolvedMessage[] | null>>();
  const loadSnapshot = async (
    nativeSessionId: string,
  ): Promise<readonly ResolvedMessage[] | null> => {
    const rows = await messages.getNativeTranscriptMessageSnapshot(
      nativeSessionId,
    );
    if (rows.length === 0) return null;
    const seenConversationIds = new Set<number>();
    const sessionMessages: ResolvedMessage[] = [];
    let currentConversationId: number | undefined;
    let expectedMessageSequence = 0;
    for (const message of rows) {
      if (
        !Number.isSafeInteger(message.conversationId)
        || message.conversationId < 0
        || !Number.isSafeInteger(message.messageId)
        || message.messageId < 0
        || !Number.isSafeInteger(message.messageSequence)
        || message.messageSequence < 0
        || !isMessageRole(message.role)
        || message.content.includes("\0")
      ) {
        return null;
      }
      if (message.conversationId !== currentConversationId) {
        if (seenConversationIds.has(message.conversationId)) return null;
        seenConversationIds.add(message.conversationId);
        currentConversationId = message.conversationId;
        expectedMessageSequence = 0;
      }
      if (message.messageSequence !== expectedMessageSequence) return null;
      expectedMessageSequence += 1;
      sessionMessages.push({
        conversationId: message.conversationId,
        messageId: message.messageId,
        role: message.role,
        content: message.content,
      });
    }
    return sessionMessages;
  };

  return {
    resolveExact: async (input) => {
      if (
        !Number.isSafeInteger(input.sessionSequence)
        || input.sessionSequence < 0
        || !isMessageRole(input.role)
        || input.nativeSessionId.length === 0
        || input.nativeSessionId.includes("\0")
        || input.content.includes("\0")
      ) {
        return null;
      }
      let snapshot = snapshots.get(input.nativeSessionId);
      if (!snapshot) {
        const loading = loadSnapshot(input.nativeSessionId);
        const cached = loading.catch((error: unknown) => {
          snapshots.delete(input.nativeSessionId);
          throw error;
        });
        snapshots.set(input.nativeSessionId, cached);
        snapshot = cached;
      }
      const sessionMessages = await snapshot;
      if (!sessionMessages) return null;
      const message = sessionMessages[input.sessionSequence];
      if (
        !message
        || message.role !== input.role
        || message.content !== input.content
      ) {
        return null;
      }
      return {
        conversationId: message.conversationId,
        messageId: message.messageId,
      };
    },
  };
}

type TranscriptCheckpointJson = JsonObject & {
  version: number;
  byteOffset: number;
  prefixSha256: string;
  scrubberVersion: string;
  source: JsonObject;
};

function checkpointJson(
  progress: {
    readonly endByteOffset: number;
    readonly prefixSha256: string;
  },
  metadata: NativeTranscriptSourceMetadata,
  scrubberVersion: string,
): TranscriptCheckpointJson {
  return {
    version: CHECKPOINT_VERSION,
    byteOffset: progress.endByteOffset,
    prefixSha256: progress.prefixSha256,
    scrubberVersion,
    source: {
      sizeBytes: metadata.sizeBytes,
      modifiedAtMs: metadata.modifiedAtMs,
      changedAtMs: metadata.changedAtMs,
    },
  };
}

function resumableByteOffset(
  checkpoint: JsonObject,
  metadata: NativeTranscriptSourceMetadata,
  scrubberVersion: string,
): number | null {
  const source = checkpoint.source;
  if (
    checkpoint.version !== CHECKPOINT_VERSION
    || checkpoint.scrubberVersion !== scrubberVersion
    || !Number.isSafeInteger(checkpoint.byteOffset)
    || (checkpoint.byteOffset as number) < 0
    || typeof checkpoint.prefixSha256 !== "string"
    || !DIGEST_PATTERN.test(checkpoint.prefixSha256)
    || source === null
    || typeof source !== "object"
    || Array.isArray(source)
    || !Number.isSafeInteger(source.sizeBytes)
    || !Number.isFinite(source.modifiedAtMs)
    || !Number.isFinite(source.changedAtMs)
    || (checkpoint.byteOffset as number) > metadata.sizeBytes
  ) {
    return null;
  }
  return checkpoint.byteOffset as number;
}

export interface NativeTranscriptBackfillOptions {
  readonly repository: NativeTranscriptRepository;
  readonly quarantine: LocalTranscriptQuarantineRepository;
  readonly source: NativeTranscriptByteSource;
  readonly machineId: string;
  readonly format: NativeTranscriptFormat;
  readonly nativeSessionId: string;
  readonly sourceLocator: string;
  readonly globalPatterns: readonly string[];
  readonly projectPatterns: readonly string[];
  readonly pipelineVersion?: string;
  readonly messageMapper?: NativeTranscriptMessageMapper;
  readonly messageResolver: ExactNativeTranscriptMessageResolver;
  readonly batchSize?: number;
  readonly clock?: () => Date;
  /** @internal Allows bounded unit tests without allocating ten MiB. */
  readonly maxRecordBytes?: number;
}

export interface NativeTranscriptBackfillResult {
  readonly importedCount: number;
  readonly skippedCount: number;
  readonly quarantinedCount: number;
  readonly resumedFromByteOffset: number;
  readonly rescanned: boolean;
}

function assertMetadata(
  metadata: NativeTranscriptSourceMetadata,
): NativeTranscriptSourceMetadata {
  assertSafeNonnegative(metadata.sizeBytes);
  if (!Number.isFinite(metadata.modifiedAtMs) || metadata.modifiedAtMs < 0) {
    throw new NativeTranscriptConfigurationError("invalid-input");
  }
  if (!Number.isFinite(metadata.changedAtMs) || metadata.changedAtMs < 0) {
    throw new NativeTranscriptConfigurationError("invalid-input");
  }
  return metadata;
}

async function messageLinks(
  record: PreparedNativeTranscriptRecord,
  candidates: readonly (
    NativeTranscriptMessageCandidate & { readonly sessionSequence: number }
  )[],
  resolver: ExactNativeTranscriptMessageResolver,
): Promise<CreateNativeTranscriptMessageLinkInput[]> {
  const links: CreateNativeTranscriptMessageLinkInput[] = [];
  for (const candidate of candidates) {
    const resolved = await resolver.resolveExact({
      nativeSessionId: record.nativeSessionId,
      sessionSequence: candidate.sessionSequence,
      role: candidate.role,
      content: candidate.content,
    });
    if (!resolved) throw new NativeTranscriptLinkError(record.sourceOrdinal);
    assertSafeNonnegative(resolved.conversationId);
    assertSafeNonnegative(resolved.messageId);
    links.push({
      conversationId: resolved.conversationId,
      messageId: resolved.messageId,
      sourceOrdinal: candidate.sourceOrdinal,
    });
  }
  return links;
}

function mappedMessageCandidates(
  record: PreparedNativeTranscriptRecord,
  format: NativeTranscriptFormat,
  mapper: NativeTranscriptMessageMapper,
  startingSessionSequence: number,
): {
  readonly candidates: readonly (
    NativeTranscriptMessageCandidate & { readonly sessionSequence: number }
  )[];
  readonly nextSessionSequence: number;
} {
  const candidates = mapper.map(
    format,
    cloneNativePayload(record.nativePayload),
    record.sourceOrdinal,
  );
  const sequenced = candidates.map((candidate, index) => ({
    ...candidate,
    sessionSequence: startingSessionSequence + index,
  }));
  for (const candidate of sequenced) {
    assertSafeNonnegative(candidate.sourceOrdinal);
    if (
      !isMessageRole(candidate.role)
      || typeof candidate.content !== "string"
      || candidate.content.includes("\0")
    ) {
      throw new NativeTranscriptConfigurationError("invalid-input");
    }
  }
  return {
    candidates: sequenced,
    nextSessionSequence: startingSessionSequence + sequenced.length,
  };
}

export async function runNativeTranscriptBackfill(
  options: NativeTranscriptBackfillOptions,
): Promise<NativeTranscriptBackfillResult> {
  assertNonemptyText(options.machineId);
  assertFormat(options.format);
  if (options.quarantine.clientName !== options.format.clientName) {
    throw new NativeTranscriptConfigurationError("invalid-input");
  }
  assertNonemptyText(options.nativeSessionId);
  assertSourceLocator(options.sourceLocator);
  const batchSize =
    options.batchSize ?? NATIVE_TRANSCRIPT_DEFAULT_BATCH_SIZE;
  if (
    !Number.isSafeInteger(batchSize)
    || batchSize < 1
    || batchSize > NATIVE_TRANSCRIPT_MAX_BATCH_SIZE
  ) {
    throw new NativeTranscriptConfigurationError("invalid-input");
  }
  // Constructing the scrubber validates every custom pattern before source,
  // quarantine, resolver, or destination access.
  const scrubber = createNativeTranscriptScrubber({
    globalPatterns: options.globalPatterns,
    projectPatterns: options.projectPatterns,
    pipelineVersion: options.pipelineVersion,
  });
  if (!options.messageResolver) {
    throw new NativeTranscriptConfigurationError("invalid-input");
  }
  const mapper =
    options.messageMapper ?? createNativeTranscriptMessageMapper();
  const snapshot = await options.source.openSnapshot();
  try {
    const metadata = assertMetadata(snapshot.metadata);
    await snapshot.assertUnchanged();
    const previous = await options.repository.getCheckpoint({
      machineId: options.machineId,
      clientName: options.format.clientName,
      sourceLocator: options.sourceLocator,
    });
    let expectedCheckpoint: NativeTranscriptCheckpointRecord | null = previous;
    const candidateOffset = previous
      ? resumableByteOffset(
          previous.checkpoint,
          metadata,
          scrubber.scrubberVersion,
        )
      : null;
    let prefixMatches = false;
    if (candidateOffset !== null) {
      await snapshot.assertUnchanged();
      prefixMatches = await snapshot.digestPrefix(candidateOffset)
        === previous?.checkpoint.prefixSha256;
      await snapshot.assertUnchanged();
    }
    const resumedFromByteOffset =
      prefixMatches && candidateOffset !== null ? candidateOffset : 0;
    const rescanned = previous !== null && !prefixMatches;
    let importedCount = 0;
    let skippedCount = 0;
    let quarantinedCount = 0;
    let batch: NativeTranscriptReadOutcome[] = [];
    let uncommittedRanges: NativeTranscriptByteRangeDigest[] = [];
    const protectedPrefixRange: NativeTranscriptByteRangeDigest | null =
      resumedFromByteOffset > 0 && previous
        ? Object.freeze({
            startByteOffset: 0,
            endByteOffset: resumedFromByteOffset,
            rangeSha256: previous.checkpoint.prefixSha256 as string,
          })
        : null;
    let committedByteOffset = resumedFromByteOffset;
    // Source size is a safe integer, each physical record consumes at least
    // one byte, and mapper results are bounded by JavaScript array length.
    // Therefore these counters cannot overflow while ingesting one snapshot.
    let nextSessionSequence = 0;
    let pendingQuarantinedRecords = 0;
    let lastSourceOrdinal =
      resumedFromByteOffset > 0 && previous ? previous.lastSourceOrdinal : 0;
    const progressState: {
      latest?: {
        readonly endByteOffset: number;
        readonly prefixSha256: string;
      };
    } = {};

    const assertUncommittedSourceUnchanged = async (): Promise<void> => {
      await snapshot.assertUnchanged();
      if (protectedPrefixRange) {
        await snapshot.assertByteRangesUnchanged([protectedPrefixRange]);
      }
      await snapshot.assertByteRangesUnchanged(uncommittedRanges);
      await snapshot.assertUnchanged();
    };

    const applyQuarantineSequence = (): void => {
      pendingQuarantinedRecords += 1;
    };

    const resolvePendingSequence = async (
      record: PreparedNativeTranscriptRecord,
      candidates: readonly (
        NativeTranscriptMessageCandidate & {
          readonly sessionSequence: number;
        }
      )[],
      mappedNextSessionSequence: number,
    ): Promise<{
      readonly links: CreateNativeTranscriptMessageLinkInput[] | null;
      readonly nextSessionSequence: number;
    }> => {
      if (pendingQuarantinedRecords === 0 || candidates.length === 0) {
        return {
          links: null,
          nextSessionSequence: mappedNextSessionSequence,
        };
      }
      if (options.messageMapper || candidates.length !== 1) {
        throw new NativeTranscriptLinkError(record.sourceOrdinal);
      }
      const lastCandidateSequence =
        nextSessionSequence + pendingQuarantinedRecords;
      const candidate = candidates[0]!;
      let match: {
        readonly conversationId: number;
        readonly messageId: number;
        readonly sessionSequence: number;
      } | null = null;
      for (
        let sessionSequence = nextSessionSequence;
        sessionSequence <= lastCandidateSequence;
        sessionSequence += 1
      ) {
        const resolved = await options.messageResolver.resolveExact({
          nativeSessionId: record.nativeSessionId,
          sessionSequence,
          role: candidate.role,
          content: candidate.content,
        });
        if (!resolved) continue;
        if (match) throw new NativeTranscriptLinkError(record.sourceOrdinal);
        match = { ...resolved, sessionSequence };
      }
      if (!match) throw new NativeTranscriptLinkError(record.sourceOrdinal);
      pendingQuarantinedRecords = 0;
      return {
        links: [{
          conversationId: match.conversationId,
          messageId: match.messageId,
          sourceOrdinal: candidate.sourceOrdinal,
        }],
        nextSessionSequence: match.sessionSequence + 1,
      };
    };

    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const last = batch.at(-1)!;
      const quarantinedRecords = batch.filter(
        (outcome): outcome is QuarantinedNativeTranscriptRecord =>
          outcome.kind === "quarantine",
      );
      await assertUncommittedSourceUnchanged();
      const records: CreateNativeTranscriptInput[] = [];
      for (const outcome of batch) {
        if (outcome.kind === "quarantine") {
          applyQuarantineSequence();
          continue;
        }
        const record = outcome;
        const mapped = mappedMessageCandidates(
          record,
          options.format,
          mapper,
          nextSessionSequence,
        );
        const sequenceResolution = await resolvePendingSequence(
          record,
          mapped.candidates,
          mapped.nextSessionSequence,
        );
        const resolvedLinks = sequenceResolution.links ?? await messageLinks(
          record,
          mapped.candidates,
          options.messageResolver,
        );
        nextSessionSequence = sequenceResolution.nextSessionSequence;
        records.push({
          formatName: record.formatName,
          formatVersion: record.formatVersion,
          nativeSessionId: record.nativeSessionId,
          sourceOrdinal: record.sourceOrdinal,
          observedAt: record.observedAt,
          scrubberVersion: record.scrubberVersion,
          contentSha256: record.contentSha256,
          ingestKey: record.ingestKey,
          nativePayload: record.nativePayload,
          messageLinks: resolvedLinks,
        });
      }
      await assertUncommittedSourceUnchanged();
      for (const record of quarantinedRecords) {
        await options.quarantine.quarantine({
          sourceLocator: options.sourceLocator,
          sourceOrdinal: record.sourceOrdinal,
          reason: record.reason,
          contentSha256: record.contentSha256,
          quarantinedAt: record.quarantinedAt,
        });
      }
      await assertUncommittedSourceUnchanged();
      const result = await options.repository.ingestBatch({
        machineId: options.machineId,
        clientName: options.format.clientName,
        sourceLocator: options.sourceLocator,
        expectedCheckpoint,
        records,
        checkpoint: {
          lastSourceOrdinal: last.sourceOrdinal,
          checkpoint: checkpointJson(
            last,
            metadata,
            scrubber.scrubberVersion,
          ),
        },
        quarantinedCount: quarantinedRecords.length,
      });
      await assertUncommittedSourceUnchanged();
      importedCount += result.importedCount;
      skippedCount += result.skippedCount;
      quarantinedCount += result.quarantinedCount;
      expectedCheckpoint = result.checkpoint;
      committedByteOffset = last.endByteOffset;
      batch = [];
      uncommittedRanges = [];
    };

    const outcomes = readNativeTranscriptJsonl({
      bytes: snapshot.stream(),
      format: options.format,
      nativeSessionId: options.nativeSessionId,
      sourceLocator: options.sourceLocator,
      scrubber,
      clock: options.clock,
      maxRecordBytes: options.maxRecordBytes,
      progressStartByteOffset: committedByteOffset,
      onProgress: (progress) => {
        progressState.latest = progress;
        uncommittedRanges.push({
          startByteOffset: progress.startByteOffset,
          endByteOffset: progress.endByteOffset,
          rangeSha256: progress.rangeSha256,
        });
      },
    });
    for await (const outcome of outcomes) {
      if (outcome.endByteOffset <= resumedFromByteOffset) {
        if (outcome.kind === "record") {
          const mapped = mappedMessageCandidates(
            outcome,
            options.format,
            mapper,
            nextSessionSequence,
          );
          const sequenceResolution = await resolvePendingSequence(
            outcome,
            mapped.candidates,
            mapped.nextSessionSequence,
          );
          nextSessionSequence = sequenceResolution.nextSessionSequence;
        } else {
          applyQuarantineSequence();
        }
        continue;
      }
      lastSourceOrdinal = outcome.sourceOrdinal;
      batch.push(outcome);
      if (batch.length === batchSize) await flush();
    }
    await flush();
    const latestProgress = progressState.latest;
    if (
      latestProgress
      && latestProgress.endByteOffset > committedByteOffset
    ) {
      await assertUncommittedSourceUnchanged();
      const result = await options.repository.ingestBatch({
        machineId: options.machineId,
        clientName: options.format.clientName,
        sourceLocator: options.sourceLocator,
        expectedCheckpoint,
        records: [],
        checkpoint: {
          lastSourceOrdinal,
          checkpoint: checkpointJson(
            latestProgress,
            metadata,
            scrubber.scrubberVersion,
          ),
        },
        quarantinedCount: 0,
      });
      await assertUncommittedSourceUnchanged();
      importedCount += result.importedCount;
      skippedCount += result.skippedCount;
      quarantinedCount += result.quarantinedCount;
      uncommittedRanges = [];
    }
    const emptyCheckpoint = checkpointJson({
      endByteOffset: 0,
      prefixSha256: sha256(""),
    }, metadata, scrubber.scrubberVersion);
    const emptyCheckpointIsExact =
      previous?.lastSourceOrdinal === 0
      && canonicalNativeTranscriptJson(previous.checkpoint)
        === canonicalNativeTranscriptJson(emptyCheckpoint);
    if (metadata.sizeBytes === 0 && !emptyCheckpointIsExact) {
      await assertUncommittedSourceUnchanged();
      const result = await options.repository.ingestBatch({
        machineId: options.machineId,
        clientName: options.format.clientName,
        sourceLocator: options.sourceLocator,
        expectedCheckpoint,
        records: [],
        checkpoint: {
          lastSourceOrdinal: 0,
          checkpoint: emptyCheckpoint,
        },
        quarantinedCount: 0,
      });
      await assertUncommittedSourceUnchanged();
      importedCount += result.importedCount;
      skippedCount += result.skippedCount;
      quarantinedCount += result.quarantinedCount;
    }
    return {
      importedCount,
      skippedCount,
      quarantinedCount,
      resumedFromByteOffset,
      rescanned,
    };
  } finally {
    await snapshot.close();
  }
}
