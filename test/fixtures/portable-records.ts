/**
 * Test-only declared-shape backend fixtures for the #616 portable record protocol.
 *
 * These fixtures freeze one representative logical project and express it in two
 * declared backend dialects:
 *
 * - a SQLite dialect using signed SQLite integer/REAL values, 0/1 nullable
 *   booleans, space-separated timestamps, JSON text, embedded tag/file arrays,
 *   authenticated installation machine identity, and no generated remote
 *   surrogate identifiers;
 * - a PostgreSQL dialect using bigint/decimal driver strings, real booleans,
 *   six-digit UTC timestamps, JSON objects, normalized relationship rows,
 *   generated UUID surrogates, and shared identity rows.
 *
 * The adapters below are declared-shape only. They prove the portable protocol
 * and deliberately do not claim or transfer ownership of the #622/#626 raw
 * backend extraction work; no SQL, driver, snapshot lifecycle, or backend writer
 * is implemented here.
 */

import { createHash } from "node:crypto";
import {
  PORTABLE_RECORD_DOMAIN_ORDER,
  createPortableRecord,
} from "../../src/storage/portable-record-stream.js";
import type {
  JsonObject,
  JsonValue,
  PortableCoverageEvidence,
  PortableDomain,
  PortableProjectIdentity,
  PortableRecord,
  PortableRecordInput,
  PortableRecordSource,
  PortableSourceDescription,
  PortableSourcePage,
  PortableSourcePageInput,
  PortableSourceVerificationInput,
} from "../../src/storage/portable-record-stream.js";

export type Backend = "sqlite" | "postgres";

/** SQLite stores integers as signed 64-bit values; the driver yields number or bigint. */
export type SqliteInteger = number | bigint;
/** SQLite has no boolean type; nullable booleans arrive as 0, 1, or null. */
export type SqliteBoolean = 0 | 1 | null;
/** SQLite timestamps in this schema are space-separated and fraction-optional. */
export type SqliteTimestamp = string;
/** PostgreSQL drivers return bigint and numeric columns as strings. */
export type PostgresBigint = string;

function compareUtf16CodeUnits(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftUnit = left.charCodeAt(index);
    const rightUnit = right.charCodeAt(index);
    if (leftUnit !== rightUnit) return leftUnit < rightUnit ? -1 : 1;
  }
  return left.length - right.length;
}

/**
 * An independent canonical JSON implementation used to derive expected digests
 * without reusing the production canonicalizer.
 */
function referenceCanonicalJson(value: unknown): string {
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "number"
    || typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(referenceCanonicalJson).join(",") + "]";
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort(compareUtf16CodeUnits);
  return "{" + keys
    .map((key) => JSON.stringify(key) + ":" + referenceCanonicalJson(object[key]))
    .join(",") + "}";
}

export function independentCanonicalJson(value: unknown): string {
  return referenceCanonicalJson(value);
}

export function independentSha256(value: unknown): string {
  return createHash("sha256")
    .update(Buffer.from(referenceCanonicalJson(value), "utf8"))
    .digest("hex");
}

export const integer = (value: string | number | bigint): { $integer: string } => ({
  $integer: String(value),
});

export function independentIdentity(
  domain: PortableDomain,
  logicalKey: readonly unknown[],
): string {
  return independentSha256(["lcm-portable-identity-v1", domain, logicalKey]);
}

export function independentConversationFingerprint(
  sessionId: string,
  title: string | null,
  bootstrappedAt: string | null,
  createdAt: string,
  updatedAt: string,
): string {
  return independentSha256([
    "lcm-portable-conversation-value-v1",
    sessionId,
    title,
    bootstrappedAt,
    createdAt,
    updatedAt,
  ]);
}

/* ------------------------------------------------------------------ *
 * Shared logical constants
 * ------------------------------------------------------------------ */

export const MACHINE_A = "installation:0b7715";
export const MACHINE_B = "installation:9f2c4a";
export const MACHINE_A_UUID = "018f7765-7b5c-7d92-8a2e-c6f6a15fca34";
export const SHARED_PROJECT_UUID = "018f7766-1c40-7a11-b3d6-5c1f0a2b7e94";
export const LOCAL_PROJECT_DIGEST = "a".repeat(64);
export const EXTERNAL_PROJECT_ID = "external-project-77";

export const SHARED_PROJECT_IDENTITY: PortableProjectIdentity = Object.freeze({
  scope: "shared",
  projectId: SHARED_PROJECT_UUID,
});
export const LOCAL_PROJECT_IDENTITY: PortableProjectIdentity = Object.freeze({
  scope: "local",
  projectId: LOCAL_PROJECT_DIGEST,
});

export const SESSION_A = "session-alpha";
export const SESSION_B = "session-beta";

export const MAX_INT64 = 2n ** 63n - 1n;
export const MAX_INT4 = 2 ** 31 - 1;
export const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** Canonical six-digit UTC spellings used by the logical model. */
export const T = Object.freeze({
  conversationCreated: "2026-08-13T12:00:00.000000Z",
  conversationUpdated: "2026-08-13T12:30:00.500000Z",
  bootstrapped: "2026-08-13T11:59:59.250000Z",
  message: "2026-08-13T12:01:02.000001Z",
  file: "2026-08-13T12:02:00.000000Z",
  summary: "2026-08-13T12:10:00.000000Z",
  summaryEarliest: "2026-08-13T12:00:30.000000Z",
  summaryLatest: "2026-08-13T12:09:45.750000Z",
  contextItem: "2026-08-13T12:11:00.000000Z",
  memory: "2026-08-13T12:12:00.000000Z",
  archived: "2026-08-13T12:13:00.000000Z",
  recall: "2026-08-13T12:14:00.000000Z",
  ingest: "2026-08-13T12:15:00.000000Z",
  instructions: "2026-08-13T12:16:00.000000Z",
  observed: "2026-08-13T12:17:00.000000Z",
  ingested: "2026-08-13T12:17:30.000000Z",
  checkpoint: "2026-08-13T12:18:00.000000Z",
  event: "2026-08-13T12:19:00.000000Z",
});

/**
 * Convert one canonical six-digit UTC spelling into the SQLite dialect: a
 * space separator and a fraction truncated of trailing zeros.  This is a
 * dialect encoder, not a normalizer; it deliberately produces the lossy-looking
 * spellings a real SQLite column holds.
 */
export function toSqliteTimestamp(canonical: string): SqliteTimestamp {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})\.(\d{6})Z$/.exec(canonical);
  if (match === null) throw new Error("fixture timestamp is not canonical: " + canonical);
  const fraction = match[3].replace(/0+$/, "");
  return match[1] + " " + match[2] + (fraction === "" ? "" : "." + fraction);
}

export function toSqliteTimestampOrNull(canonical: string | null): SqliteTimestamp | null {
  return canonical === null ? null : toSqliteTimestamp(canonical);
}

export function toSqliteBoolean(value: boolean | null): SqliteBoolean {
  return value === null ? null : value ? 1 : 0;
}

/* ------------------------------------------------------------------ *
 * Backend-neutral logical specification
 *
 * One representative logical project.  Both dialect encoders below read this
 * specification and re-express it in their own declared physical shapes,
 * including different physical row identifiers.
 * ------------------------------------------------------------------ */

export interface LogicalConversation {
  readonly handle: string;
  readonly sqliteId: number;
  readonly pgUuid: string;
  readonly pgPk: string;
  readonly sessionId: string;
  readonly title: string | null;
  readonly bootstrappedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LogicalMessage {
  readonly handle: string;
  readonly conversation: string;
  readonly sqliteId: number;
  readonly pgUuid: string;
  readonly pgPk: string;
  readonly seq: number;
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly tokenCount: number;
  readonly createdAt: string;
}
export interface LogicalSpec {
  readonly conversations: readonly LogicalConversation[];
  readonly messages: readonly LogicalMessage[];
}

/**
 * Physical identifiers deliberately differ between the two backends: SQLite
 * uses small autoincrement rowids, PostgreSQL uses generated UUID surrogates
 * and large bigint primary keys.  Canonical records must not observe either.
 */
export const CONVERSATIONS: readonly LogicalConversation[] = Object.freeze([
  Object.freeze({
    handle: "alpha",
    sqliteId: 1,
    pgUuid: "018f7767-2a00-7c55-9d10-2f0f6d3a1101",
    pgPk: "9007199254740993",
    sessionId: SESSION_A,
    title: "Alpha conversation",
    bootstrappedAt: T.bootstrapped,
    createdAt: T.conversationCreated,
    updatedAt: T.conversationUpdated,
  }),
  Object.freeze({
    handle: "alpha-twin",
    sqliteId: 2,
    pgUuid: "018f7767-2a00-7c55-9d10-2f0f6d3a1102",
    pgPk: "9007199254740994",
    sessionId: SESSION_A,
    title: "Alpha conversation",
    bootstrappedAt: T.bootstrapped,
    createdAt: T.conversationCreated,
    updatedAt: T.conversationUpdated,
  }),
  Object.freeze({
    handle: "alpha-divergent",
    sqliteId: 5,
    pgUuid: "018f7767-2a00-7c55-9d10-2f0f6d3a1105",
    pgPk: "9007199254740997",
    sessionId: SESSION_A,
    title: "Alpha conversation",
    bootstrappedAt: T.bootstrapped,
    createdAt: T.conversationCreated,
    updatedAt: T.conversationUpdated,
  }),
  Object.freeze({
    handle: "alpha-variant",
    sqliteId: 3,
    pgUuid: "018f7767-2a00-7c55-9d10-2f0f6d3a1103",
    pgPk: "9007199254740995",
    sessionId: SESSION_A,
    title: "Alpha conversation (variant)",
    bootstrappedAt: T.bootstrapped,
    createdAt: T.conversationCreated,
    updatedAt: T.conversationUpdated,
  }),
  Object.freeze({
    handle: "beta",
    sqliteId: 4,
    pgUuid: "018f7767-2a00-7c55-9d10-2f0f6d3a1104",
    pgPk: "9007199254740996",
    sessionId: SESSION_B,
    title: null,
    bootstrappedAt: null,
    createdAt: T.conversationCreated,
    updatedAt: T.conversationUpdated,
  }),
]);

export const MESSAGES: readonly LogicalMessage[] = Object.freeze([
  Object.freeze({
    handle: "alpha-0",
    conversation: "alpha",
    sqliteId: 11,
    pgUuid: "018f7768-3b00-7e66-8a21-3f1f7e4b2201",
    pgPk: "9007199254741001",
    seq: 0,
    role: "user" as const,
    content: "Explain the portable record protocol.",
    tokenCount: 12,
    createdAt: T.message,
  }),
  Object.freeze({
    handle: "alpha-1",
    conversation: "alpha",
    sqliteId: 12,
    pgUuid: "018f7768-3b00-7e66-8a21-3f1f7e4b2202",
    pgPk: "9007199254741002",
    seq: 1,
    role: "assistant" as const,
    content: "It is a backend-neutral canonical record stream.",
    tokenCount: 24,
    createdAt: T.message,
  }),
  Object.freeze({
    handle: "alpha-twin-0",
    conversation: "alpha-twin",
    sqliteId: 14,
    pgUuid: "018f7768-3b00-7e66-8a21-3f1f7e4b2204",
    pgPk: "9007199254741004",
    seq: 0,
    role: "user" as const,
    content: "Explain the portable record protocol.",
    tokenCount: 12,
    createdAt: T.message,
  }),
  Object.freeze({
    handle: "alpha-twin-1",
    conversation: "alpha-twin",
    sqliteId: 15,
    pgUuid: "018f7768-3b00-7e66-8a21-3f1f7e4b2205",
    pgPk: "9007199254741005",
    seq: 1,
    role: "assistant" as const,
    content: "It is a backend-neutral canonical record stream.",
    tokenCount: 24,
    createdAt: T.message,
  }),
  Object.freeze({
    handle: "alpha-divergent-0",
    conversation: "alpha-divergent",
    sqliteId: 16,
    pgUuid: "018f7768-3b00-7e66-8a21-3f1f7e4b2206",
    pgPk: "9007199254741006",
    seq: 0,
    role: "user" as const,
    content: "This closure is deliberately different.",
    tokenCount: 7,
    createdAt: T.message,
  }),
  Object.freeze({
    handle: "beta-0",
    conversation: "beta",
    sqliteId: 13,
    pgUuid: "018f7768-3b00-7e66-8a21-3f1f7e4b2203",
    pgPk: "9007199254741003",
    seq: 0,
    role: "system" as const,
    content: "",
    tokenCount: 0,
    createdAt: T.message,
  }),
]);

export const SPEC: LogicalSpec = Object.freeze({
  conversations: CONVERSATIONS,
  messages: MESSAGES,
});

export function conversationByHandle(handle: string): LogicalConversation {
  const found = CONVERSATIONS.find((item) => item.handle === handle);
  if (found === undefined) throw new Error("unknown conversation handle: " + handle);
  return found;
}

export function messageByHandle(handle: string): LogicalMessage {
  const found = MESSAGES.find((item) => item.handle === handle);
  if (found === undefined) throw new Error("unknown message handle: " + handle);
  return found;
}
/* ------------------------------------------------------------------ *
 * Adapter-owned closure and occurrence assignment
 * ------------------------------------------------------------------ */

/**
 * The identity-free closure projection for one conversation.  Physical row
 * identifiers are deliberately absent so two backends compute the same
 * closure for the same logical conversation.
 */
export interface ConversationClosure {
  readonly sessionId: string;
  readonly title: string | null;
  readonly bootstrappedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: readonly (readonly [number, string, string, number, string])[];
}

export function conversationClosure(
  conversation: LogicalConversation,
  messages: readonly LogicalMessage[],
): ConversationClosure {
  return {
    sessionId: conversation.sessionId,
    title: conversation.title,
    bootstrappedAt: conversation.bootstrappedAt,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messages: messages
      .filter((message) => message.conversation === conversation.handle)
      .map((message) => [
        message.seq,
        message.role,
        message.content,
        message.tokenCount,
        message.createdAt,
      ] as const),
  };
}

export type ClosureDigest = (closure: ConversationClosure) => string;

export const defaultClosureDigest: ClosureDigest = (closure) =>
  independentSha256(["lcm-fixture-closure-v1", closure]);

/**
 * Assign each conversation its occurrence ordinal.
 *
 * Conversations whose full canonical closure is identical form one class and
 * receive a contiguous ordinal block that preserves exact multiplicity.
 * Conversations with distinct closures each start their own block at zero.
 * A digest match is never trusted alone: the full canonical closure is
 * compared, so a forced digest collision is rejected instead of silently
 * merging two unlike conversations.
 */
export function assignConversationOrdinals(
  conversations: readonly LogicalConversation[],
  messages: readonly LogicalMessage[],
  digest: ClosureDigest = defaultClosureDigest,
): ReadonlyMap<string, number> {
  const ordinals = new Map<string, number>();
  const groups = new Map<string, LogicalConversation[]>();
  for (const conversation of conversations) {
    const fingerprint = independentConversationFingerprint(
      conversation.sessionId,
      conversation.title,
      conversation.bootstrappedAt,
      conversation.createdAt,
      conversation.updatedAt,
    );
    const group = groups.get(fingerprint);
    if (group === undefined) groups.set(fingerprint, [conversation]);
    else group.push(conversation);
  }
  for (const group of groups.values()) {
    // full-closure -> digest -> full-byte collision check -> preserve class
    // multiplicity -> unsigned-digest class sort -> contiguous ordinal block
    const classes = new Map<string, { canonical: string; members: LogicalConversation[] }>();
    for (const conversation of group) {
      const closure = conversationClosure(conversation, messages);
      const key = digest(closure);
      const canonical = independentCanonicalJson(closure);
      const existing = classes.get(key);
      if (existing === undefined) {
        classes.set(key, { canonical, members: [conversation] });
        continue;
      }
      if (existing.canonical !== canonical) {
        throw new Error("closure digest collision rejected by full canonical comparison");
      }
      existing.members.push(conversation);
    }
    const sorted = [...classes.entries()].sort((left, right) =>
      Buffer.from(left[0], "hex").compare(Buffer.from(right[0], "hex")),
    );
    let next = 0;
    for (const [, entry] of sorted) {
      for (const member of entry.members) {
        ordinals.set(member.handle, next);
        next += 1;
      }
    }
  }
  return ordinals;
}

/**
 * Repeated identical recall tuples keep their occurrence ordinals.  Adapters
 * may enumerate physically distinct equal rows solely to assign this ordinal.
 */
export function assignRecallOrdinals(
  rows: readonly Readonly<{ memoryId: string; sessionId: string | null; surfacedAt: string }>[],
): readonly number[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = independentCanonicalJson([row.memoryId, row.sessionId, row.surfacedAt]);
    const next = seen.get(key) ?? 0;
    seen.set(key, next + 1);
    return next;
  });
}
/* ------------------------------------------------------------------ *
 * Declared-shape dialect encoders
 *
 * Each backend re-expresses the same logical values in its own declared
 * scalar dialect.  The adapters then decode those dialect scalars into the
 * raw scalar unions the public codec accepts.
 * ------------------------------------------------------------------ */

export interface Dialect {
  readonly backend: Backend;
  /** Encode a nonnegative logical integer in the backend's declared shape. */
  readonly int: (value: number | bigint) => number | bigint | string;
  /** Encode a nullable logical integer. */
  readonly nullableInt: (value: number | bigint | null) => number | bigint | string | null;
  /** Encode a logical timestamp. */
  readonly timestamp: (canonical: string) => string;
  readonly nullableTimestamp: (canonical: string | null) => string | null;
  /** Encode a nullable logical boolean. */
  readonly bool: (value: boolean | null) => boolean | 0 | 1 | null;
  /** Encode a finite decimal. */
  readonly decimal: (value: number) => number | string;
  readonly nullableDecimal: (value: number | null) => number | string | null;
  /** Encode an embedded JSON document. */
  readonly json: (value: JsonObject) => JsonObject | string;
  readonly jsonAny: (value: JsonObject | readonly JsonValue[]) => JsonObject | readonly JsonValue[] | string;
}

export const SQLITE_DIALECT: Dialect = Object.freeze({
  backend: "sqlite" as const,
  int: (value) => (typeof value === "bigint" && value <= BigInt(MAX_SAFE) ? Number(value) : value),
  nullableInt: (value) =>
    value === null ? null : (typeof value === "bigint" && value <= BigInt(MAX_SAFE) ? Number(value) : value),
  timestamp: (canonical) => toSqliteTimestamp(canonical),
  nullableTimestamp: (canonical) => toSqliteTimestampOrNull(canonical),
  bool: (value) => toSqliteBoolean(value),
  decimal: (value) => value,
  nullableDecimal: (value) => value,
  json: (value) => independentCanonicalJson(value),
  jsonAny: (value) => independentCanonicalJson(value),
});

export const POSTGRES_DIALECT: Dialect = Object.freeze({
  backend: "postgres" as const,
  int: (value) => String(value),
  nullableInt: (value) => (value === null ? null : String(value)),
  timestamp: (canonical) => canonical,
  nullableTimestamp: (canonical) => canonical,
  bool: (value) => value,
  decimal: (value) => String(value),
  nullableDecimal: (value) => (value === null ? null : String(value)),
  json: (value) => value,
  jsonAny: (value) => value,
});

/**
 * Decode an embedded JSON document from either dialect.  SQLite stores JSON
 * text; PostgreSQL returns a parsed object.
 */
export function decodeJson(value: JsonObject | readonly JsonValue[] | string): JsonObject | readonly JsonValue[] {
  return typeof value === "string"
    ? (JSON.parse(value) as JsonObject | readonly JsonValue[])
    : value;
}

export function decodeJsonObject(value: JsonObject | string): JsonObject {
  return decodeJson(value) as JsonObject;
}

/** Decode a nullable dialect boolean into the portable nullable boolean. */
export function decodeBoolean(value: boolean | 0 | 1 | null): boolean | null {
  return value === null ? null : typeof value === "boolean" ? value : value === 1;
}

/** Decode a dialect decimal into a finite number. */
export function decodeDecimal(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}

export function decodeNullableDecimal(value: number | string | null): number | null {
  return value === null ? null : decodeDecimal(value);
}
/* ------------------------------------------------------------------ *
 * The 22-domain adapter
 * ------------------------------------------------------------------ */

export interface AdapterOptions {
  readonly dialect: Dialect;
  readonly projectIdentity: PortableProjectIdentity;
  /**
   * Legacy SQLite generations never stored native transcripts; those three
   * domains are then authoritative-empty rather than merely absent.
   */
  readonly legacyGeneration?: boolean;
  /** Promoted-memory provenance spelling exercised by this generation. */
  readonly sourceProjectSpelling?: "sql-null" | "explicit-self" | "external";
  /** Optional passive-event delivery override used by the disposition proof. */
  readonly passiveOverride?: readonly PassiveEventState[];
  /**
   * Optional closure digest used to force a hash collision and prove the
   * adapter rejects it by full canonical comparison.
   */
  readonly closureDigest?: ClosureDigest;
  /** Optional per-domain value overrides used by malformed/limit cases. */
  readonly mutate?: (domain: PortableDomain, values: readonly UnknownRecord[]) => readonly UnknownRecord[];
}

export type UnknownRecord = Record<string, unknown>;

/**
 * One passive event expressed in both backends' delivery vocabularies.  The
 * two spellings are deliberately unlike: the proof is that they normalize to
 * the same portable disposition, not that they are stored the same way.
 */
export interface PassiveEventState {
  readonly eventId: string;
  /** Local sidecar execution state. */
  readonly processedAt: string | null;
  readonly deliveryState: string;
  /** PostgreSQL queue state. */
  readonly postgresState: string;
}

export interface DomainDraft {
  readonly domain: PortableDomain;
  readonly values: readonly UnknownRecord[];
  readonly contexts: readonly unknown[];
}

const PART_ID = "part-alpha-0";
const SUMMARY_LEAF = "summary-leaf-1";
const SUMMARY_LEAF_TWO = "summary-leaf-2";
const SUMMARY_ROOT = "summary-root-1";
const FILE_ID = "file-alpha-1";
const ORPHAN_FILE_ID = "file-orphan-9";
const MEMORY_ID = "memory-alpha-1";
const ORPHAN_SUMMARY_ID = "summary-orphan-9";
const INGEST_KEY = "b".repeat(64);
const CONTENT_SHA = "c".repeat(64);
const SCOPE_HASH = "d".repeat(64);
const CONTENT_HASH = "e".repeat(64);
const PATCH_HASH = "f".repeat(64);
const SNAPSHOT_HASH = "1".repeat(64);
const EVENT_PENDING = "018f7769-4c00-7f77-9b32-4a2f8f5c3301";
const EVENT_APPLIED = "018f7769-4c00-7f77-9b32-4a2f8f5c3302";
const EVENT_QUARANTINED = "018f7769-4c00-7f77-9b32-4a2f8f5c3303";

export const FIXTURE_IDS = Object.freeze({
  PART_ID,
  SUMMARY_LEAF,
  SUMMARY_LEAF_TWO,
  SUMMARY_ROOT,
  FILE_ID,
  ORPHAN_FILE_ID,
  MEMORY_ID,
  ORPHAN_SUMMARY_ID,
  INGEST_KEY,
  CONTENT_SHA,
  SCOPE_HASH,
  CONTENT_HASH,
  PATCH_HASH,
  SNAPSHOT_HASH,
  EVENT_PENDING,
  EVENT_APPLIED,
  EVENT_QUARANTINED,
});

/**
 * Normalize a passive-event delivery state into the portable disposition.
 *
 * Precedence is exact and prevents a promoted source event from being replayed
 * after its resulting memories were copied: processed or acknowledged is
 * applied; only an unprocessed quarantine is quarantined; everything else is
 * pending.  Claim owner, attempt counts, retry timestamps, inbox identity, and
 * arbitrary quarantine text are never inputs.
 */
export function normalizeLocalDisposition(
  processedAt: string | null,
  deliveryState: string,
): "pending" | "applied" | "quarantined" {
  if (processedAt !== null || deliveryState === "acknowledged") return "applied";
  if (deliveryState === "quarantined") return "quarantined";
  return "pending";
}

export function normalizePostgresDisposition(state: string): "pending" | "applied" | "quarantined" {
  if (state === "applied") return "applied";
  if (state === "quarantined") return "quarantined";
  return "pending";
}

/**
 * The default triple exercises all three dispositions.  The pending event is
 * mid-claim on both sides, the applied event is processed locally but only
 * literally applied remotely, and the quarantined event is unprocessed and
 * quarantined on both sides.
 */
export const DEFAULT_PASSIVE_STATES: readonly PassiveEventState[] = Object.freeze([
  Object.freeze({
    eventId: EVENT_PENDING,
    processedAt: null,
    deliveryState: "claimed",
    postgresState: "retry",
  }),
  Object.freeze({
    eventId: EVENT_APPLIED,
    processedAt: T.event,
    deliveryState: "retry",
    postgresState: "applied",
  }),
  Object.freeze({
    eventId: EVENT_QUARANTINED,
    processedAt: null,
    deliveryState: "quarantined",
    postgresState: "quarantined",
  }),
]);
/**
 * Build the complete ordered 22-domain draft inventory for one backend
 * generation.  Every value is expressed through the backend dialect, so the
 * public codec receives genuinely different raw scalars for the same logical
 * data.
 */
export function buildDomainDrafts(options: AdapterOptions): readonly DomainDraft[] {
  const d = options.dialect;
  const projectIdentity = options.projectIdentity;
  const legacy = options.legacyGeneration === true;
  const spelling = options.sourceProjectSpelling ?? "sql-null";
  const ordinals = assignConversationOrdinals(
    CONVERSATIONS,
    MESSAGES,
    options.closureDigest ?? defaultClosureDigest,
  );

  const fingerprintOf = (conversation: LogicalConversation): string =>
    independentConversationFingerprint(
      conversation.sessionId,
      conversation.title,
      conversation.bootstrappedAt,
      conversation.createdAt,
      conversation.updatedAt,
    );

  const rawConversationOrder = (conversation: LogicalConversation): readonly unknown[] => [
    conversation.sessionId,
    conversation.title,
    d.nullableTimestamp(conversation.bootstrappedAt),
    d.timestamp(conversation.createdAt),
    d.timestamp(conversation.updatedAt),
    d.int(ordinals.get(conversation.handle) as number),
  ];

  const conversationIdentityOf = (conversation: LogicalConversation): string =>
    independentIdentity("conversations", [
      fingerprintOf(conversation),
      integer(ordinals.get(conversation.handle) as number),
    ]);

  const rawMessageOrder = (message: LogicalMessage): readonly unknown[] => [
    ...rawConversationOrder(conversationByHandle(message.conversation)),
    d.int(message.seq),
  ];

  const messageIdentityOf = (message: LogicalMessage): string =>
    independentIdentity("messages", [
      conversationIdentityOf(conversationByHandle(message.conversation)),
      integer(message.seq),
    ]);

  const alpha = conversationByHandle("alpha");
  const alphaMessage0 = messageByHandle("alpha-0");
  const alphaMessage1 = messageByHandle("alpha-1");
  const alphaIdentity = conversationIdentityOf(alpha);
  const message0Identity = messageIdentityOf(alphaMessage0);
  const message1Identity = messageIdentityOf(alphaMessage1);

  const passiveStates: readonly PassiveEventState[] = options.passiveOverride ?? DEFAULT_PASSIVE_STATES;

  const sourceProjectId =
    spelling === "external"
      ? EXTERNAL_PROJECT_ID
      : spelling === "explicit-self"
        ? projectIdentity.projectId
        : null;
  /**
   * Canonical null means "this stream's own project or no distinct external
   * source".  SQL NULL and an explicit self reference collapse to null; only a
   * distinct external provenance string survives verbatim.
   */
  const canonicalSourceProjectId =
    sourceProjectId === null || sourceProjectId === projectIdentity.projectId
      ? null
      : sourceProjectId;

  /*
   * Declared physical shapes are decoded by the adapter before the codec sees
   * them: SQLite 0/1 becomes a real boolean, JSON text becomes a document, and
   * a PostgreSQL decimal driver string becomes a finite number.  Integers and
   * timestamps are passed through in their declared dialect spelling because
   * the codec accepts those raw scalar unions directly.
   */
  const bool = (value: boolean | null): boolean | null => decodeBoolean(d.bool(value));
  const dec = (value: number): number => decodeDecimal(d.decimal(value));
  const decOrNull = (value: number | null): number | null => decodeNullableDecimal(d.nullableDecimal(value));
  const jsonObject = (value: JsonObject): JsonObject => decodeJsonObject(d.json(value));
  const jsonAny = (value: JsonObject | readonly JsonValue[]): JsonObject | readonly JsonValue[] =>
    decodeJson(d.jsonAny(value));

  const drafts: DomainDraft[] = [];
  const push = (
    domain: PortableDomain,
    values: readonly UnknownRecord[],
    context: unknown,
  ): void => {
    drafts.push({
      domain,
      values,
      contexts: values.map(() => context),
    });
  };
  push("machines", [
    { identityKey: MACHINE_A, machineId: MACHINE_A_UUID },
    { identityKey: MACHINE_B, machineId: null },
  ], null);

  push("project", [{ identity: projectIdentity }], null);

  // Aliases retain both the exact stored path and its normalized form; the
  // logical key is machine plus normalized path, so a second machine may hold
  // the same normalized path independently.
  push("project-aliases", [
    {
      machineIdentityKey: MACHINE_A,
      path: "/srv/Repos/Project",
      normalizedPath: "/srv/repos/project",
    },
    {
      machineIdentityKey: MACHINE_A,
      path: "/srv/Repos/Project/Worktrees/Feature",
      normalizedPath: "/srv/repos/project/worktrees/feature",
    },
    {
      machineIdentityKey: MACHINE_B,
      path: "/home/other/project",
      normalizedPath: "/home/other/project",
    },
  ], { projectIdentity });

  push(
    "conversations",
    CONVERSATIONS.map((conversation) => ({
      conversationFingerprint: fingerprintOf(conversation),
      occurrenceOrdinal: d.int(ordinals.get(conversation.handle) as number),
      sessionId: conversation.sessionId,
      createdAt: d.timestamp(conversation.createdAt),
      title: conversation.title,
      bootstrappedAt: d.nullableTimestamp(conversation.bootstrappedAt),
      updatedAt: d.timestamp(conversation.updatedAt),
    })),
    { projectIdentity },
  );
  // Conversations carry per-record parent context, so rebind it exactly.
  drafts[drafts.length - 1] = {
    domain: "conversations",
    values: drafts[drafts.length - 1].values,
    contexts: CONVERSATIONS.map(() => ({ projectIdentity })),
  };

  drafts.push({
    domain: "messages",
    values: MESSAGES.map((message) => ({
      conversationIdentitySha256: conversationIdentityOf(conversationByHandle(message.conversation)),
      seq: d.int(message.seq),
      role: message.role,
      content: message.content,
      tokenCount: d.int(message.tokenCount),
      createdAt: d.timestamp(message.createdAt),
    })),
    contexts: MESSAGES.map((message) => ({
      conversationOrder: rawConversationOrder(conversationByHandle(message.conversation)),
    })),
  });

  drafts.push({
    domain: "message-parts",
    values: [
      {
        // Every field populated at once.
        messageIdentitySha256: message0Identity,
        partId: PART_ID,
        sessionId: SESSION_A,
        partType: "tool",
        ordinal: d.int(0),
        textContent: "tool call",
        isIgnored: bool(false),
        isSynthetic: bool(true),
        toolCallId: "call-1",
        toolName: "search",
        toolStatus: "success",
        toolInput: "{\"q\":1}",
        toolOutput: "ok",
        toolError: "",
        toolTitle: "Search",
        patchHash: PATCH_HASH,
        patchFiles: "a.ts\nb.ts",
        fileMime: "text/plain",
        fileName: "a.ts",
        fileUrl: "file:///a.ts",
        subtaskPrompt: "do the thing",
        subtaskDescription: "subtask",
        subtaskAgent: "agent-1",
        stepReason: "finished",
        stepCost: dec(0.125),
        stepTokensIn: d.int(10),
        stepTokensOut: d.int(20),
        snapshotHash: SNAPSHOT_HASH,
        compactionAuto: bool(true),
        metadata: "{\"k\":\"v\"}",
      },
      {
        // Every nullable field null, and the alternate boolean spellings.
        messageIdentitySha256: message0Identity,
        partId: "part-alpha-1",
        sessionId: SESSION_A,
        partType: "text",
        ordinal: d.int(1),
        textContent: null,
        isIgnored: bool(true),
        isSynthetic: bool(false),
        toolCallId: null,
        toolName: null,
        toolStatus: null,
        toolInput: null,
        toolOutput: null,
        toolError: null,
        toolTitle: null,
        patchHash: null,
        patchFiles: null,
        fileMime: null,
        fileName: null,
        fileUrl: null,
        subtaskPrompt: null,
        subtaskDescription: null,
        subtaskAgent: null,
        stepReason: null,
        stepCost: decOrNull(null),
        stepTokensIn: null,
        stepTokensOut: null,
        snapshotHash: null,
        compactionAuto: bool(null),
        metadata: null,
      },
    ],
    contexts: [
      { messageOrder: rawMessageOrder(alphaMessage0) },
      { messageOrder: rawMessageOrder(alphaMessage0) },
    ],
  });
  push("large-files", [
    {
      fileId: FILE_ID,
      conversationIdentitySha256: alphaIdentity,
      fileName: "notes.md",
      mimeType: "text/markdown",
      byteSize: d.int(4096),
      storageUri: "lcm://files/alpha-1",
      explorationSummary: "notes",
      createdAt: d.timestamp(T.file),
    },
    {
      fileId: "file-alpha-2",
      conversationIdentitySha256: alphaIdentity,
      fileName: null,
      mimeType: null,
      byteSize: null,
      storageUri: "lcm://files/alpha-2",
      explorationSummary: null,
      createdAt: d.timestamp(T.file),
    },
  ], null);

  push("summaries", [
    {
      summaryId: SUMMARY_LEAF,
      conversationIdentitySha256: alphaIdentity,
      kind: "leaf",
      depth: d.int(0),
      content: "leaf summary one",
      tokenCount: d.int(31),
      earliestAt: d.nullableTimestamp(T.summaryEarliest),
      latestAt: d.nullableTimestamp(T.summaryLatest),
      descendantCount: d.int(2),
      descendantTokenCount: d.int(36),
      sourceMessageTokenCount: d.int(36),
      createdAt: d.timestamp(T.summary),
    },
    {
      summaryId: SUMMARY_LEAF_TWO,
      conversationIdentitySha256: alphaIdentity,
      kind: "leaf",
      depth: d.int(0),
      content: "leaf summary two",
      tokenCount: d.int(15),
      earliestAt: null,
      latestAt: null,
      descendantCount: d.int(0),
      descendantTokenCount: d.int(0),
      sourceMessageTokenCount: d.int(0),
      createdAt: d.timestamp(T.summary),
    },
    {
      summaryId: SUMMARY_ROOT,
      conversationIdentitySha256: alphaIdentity,
      kind: "condensed",
      depth: d.int(1),
      content: "condensed root",
      tokenCount: d.int(20),
      earliestAt: d.nullableTimestamp(T.summaryEarliest),
      latestAt: d.nullableTimestamp(T.summaryLatest),
      descendantCount: d.int(2),
      descendantTokenCount: d.int(46),
      sourceMessageTokenCount: d.int(36),
      createdAt: d.timestamp(T.summary),
    },
  ], null);

  // Ordered file links, including a duplicate file id at a later ordinal and an
  // orphan-legal reference to a file this generation does not carry.
  push("summary-file-links", [
    { summaryId: SUMMARY_LEAF, ordinal: d.int(0), fileId: FILE_ID },
    { summaryId: SUMMARY_LEAF, ordinal: d.int(1), fileId: ORPHAN_FILE_ID },
    { summaryId: SUMMARY_LEAF, ordinal: d.int(2), fileId: FILE_ID },
  ], null);

  push("summary-message-links", [
    { summaryId: SUMMARY_LEAF, ordinal: d.int(0), messageIdentitySha256: message0Identity },
    { summaryId: SUMMARY_LEAF, ordinal: d.int(1), messageIdentitySha256: message1Identity },
  ], null);

  // Two summary levels joined by a parent edge.
  push("summary-parent-links", [
    { summaryId: SUMMARY_LEAF, ordinal: d.int(0), parentSummaryId: SUMMARY_ROOT },
    { summaryId: SUMMARY_LEAF_TWO, ordinal: d.int(0), parentSummaryId: SUMMARY_ROOT },
  ], null);

  // Both context target types.
  drafts.push({
    domain: "context-items",
    values: [
      {
        conversationIdentitySha256: alphaIdentity,
        ordinal: d.int(0),
        itemType: "message",
        messageIdentitySha256: message0Identity,
        summaryId: null,
        createdAt: d.timestamp(T.contextItem),
      },
      {
        conversationIdentitySha256: alphaIdentity,
        ordinal: d.int(1),
        itemType: "summary",
        messageIdentitySha256: null,
        summaryId: SUMMARY_LEAF,
        createdAt: d.timestamp(T.contextItem),
      },
    ],
    contexts: [
      { conversationOrder: rawConversationOrder(alpha) },
      { conversationOrder: rawConversationOrder(alpha) },
    ],
  });

  push("promoted-memories", [
    {
      memoryId: MEMORY_ID,
      content: "portable records are backend neutral",
      metadata: jsonObject({ scope: "storage", nested: { ok: true }, list: [1, 2, 3] }),
      sourceProjectId: canonicalSourceProjectId,
      // Orphan-legal source-memory reference.
      sourceSummaryId: ORPHAN_SUMMARY_ID,
      sessionId: SESSION_A,
      depth: d.int(1),
      confidence: dec(0.75),
      createdAt: d.timestamp(T.memory),
      archivedAt: d.nullableTimestamp(T.archived),
    },
    {
      memoryId: "memory-alpha-2",
      content: "",
      metadata: jsonObject({}),
      sourceProjectId: null,
      sourceSummaryId: null,
      sessionId: null,
      depth: d.int(0),
      confidence: dec(1),
      createdAt: d.timestamp(T.memory),
      archivedAt: null,
    },
  ], { projectIdentity });

  // Duplicate ordered tags: the same tag text appears twice at distinct ordinals.
  push("promoted-memory-tags", [
    { memoryId: MEMORY_ID, ordinal: d.int(0), tag: "storage" },
    { memoryId: MEMORY_ID, ordinal: d.int(1), tag: "protocol" },
    { memoryId: MEMORY_ID, ordinal: d.int(2), tag: "storage" },
  ], null);
  // Repeated recall occurrences plus a nullable recall session.
  const recallRows = [
    { memoryId: MEMORY_ID, sessionId: SESSION_A, surfacedAt: T.recall },
    { memoryId: MEMORY_ID, sessionId: SESSION_A, surfacedAt: T.recall },
    { memoryId: MEMORY_ID, sessionId: null, surfacedAt: T.recall },
  ] as const;
  const recallOrdinals = assignRecallOrdinals(recallRows);
  push(
    "recall-surfacings",
    recallRows.map((row, index) => ({
      memoryId: row.memoryId,
      sessionId: row.sessionId,
      surfacedAt: d.timestamp(row.surfacedAt),
      occurrenceOrdinal: d.int(recallOrdinals[index]),
    })),
    { projectIdentity },
  );

  // All four redaction categories.
  push("redaction-counters", [
    { category: "built_in", count: d.int(7) },
    { category: "global", count: d.int(0) },
    { category: "project", count: d.int(3) },
    { category: "gitleaks", count: d.int(11) },
  ], { projectIdentity });

  push("session-ingest", [
    { sessionId: SESSION_A, messageCount: d.int(2), completedAt: d.timestamp(T.ingest) },
    { sessionId: SESSION_B, messageCount: d.int(1), completedAt: d.timestamp(T.ingest) },
  ], { projectIdentity });

  // Machine-scoped instructions: the same scope hash on two machines.
  push("session-instructions", [
    {
      machineIdentityKey: MACHINE_A,
      scopeHash: SCOPE_HASH,
      clientName: "codex",
      sessionId: SESSION_A,
      worktreePath: "/srv/repos/project",
      cwdPath: "/srv/repos/project/src",
      content: "project instructions",
      contentHash: CONTENT_HASH,
      updatedAt: d.timestamp(T.instructions),
    },
    {
      machineIdentityKey: MACHINE_B,
      scopeHash: SCOPE_HASH,
      clientName: "claude",
      sessionId: SESSION_B,
      worktreePath: "/home/other/project",
      cwdPath: "/home/other/project",
      content: "project instructions",
      contentHash: CONTENT_HASH,
      updatedAt: d.timestamp(T.instructions),
    },
  ], { projectIdentity });

  if (legacy) {
    // A proven legacy generation never stored these three domains at all.
    drafts.push({ domain: "native-transcripts", values: [], contexts: [] });
    drafts.push({ domain: "native-transcript-message-links", values: [], contexts: [] });
    drafts.push({ domain: "native-transcript-checkpoints", values: [], contexts: [] });
  } else {
    // Native payloads as both an object and an array.
    const objectPayload: JsonObject = {
      kind: "session",
      turns: [{ role: "user", text: "hello" }],
      meta: { scrubbed: true },
    };
    const arrayPayload: readonly JsonValue[] = [
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" },
    ];
    const transcripts = [
      {
        machineIdentityKey: MACHINE_A,
        clientName: "codex",
        formatName: "jsonl",
        formatVersion: "1",
        nativeSessionId: "native-alpha",
        sourceLocator: "/var/log/codex/alpha.jsonl",
        sourceOrdinal: d.int(0),
        observedAt: d.timestamp(T.observed),
        ingestedAt: d.timestamp(T.ingested),
        scrubberVersion: "3",
        contentSha256: CONTENT_SHA,
        ingestKey: INGEST_KEY,
        nativePayload: jsonAny(objectPayload),
      },
      {
        machineIdentityKey: MACHINE_A,
        clientName: "claude",
        formatName: "jsonl",
        formatVersion: "2",
        nativeSessionId: "native-beta",
        sourceLocator: "/var/log/claude/beta.jsonl",
        sourceOrdinal: d.int(1),
        observedAt: d.timestamp(T.observed),
        ingestedAt: d.timestamp(T.ingested),
        scrubberVersion: "3",
        contentSha256: CONTENT_SHA,
        ingestKey: "9".repeat(64),
        nativePayload: jsonAny(arrayPayload),
      },
    ];
    drafts.push({
      domain: "native-transcripts",
      values: transcripts,
      contexts: transcripts.map((value) => ({
        projectIdentity,
        canonicalPayloadBytes: nativePayloadBytes(value.nativePayload),
        canonicalMetadataBytes: nativeMetadataBytes(value, d),
      })),
    });

    // Ordered transcript links.
    push("native-transcript-message-links", [
      {
        machineIdentityKey: MACHINE_A,
        ingestKey: INGEST_KEY,
        sourceOrdinal: d.int(0),
        conversationIdentitySha256: alphaIdentity,
        messageIdentitySha256: message0Identity,
      },
      {
        machineIdentityKey: MACHINE_A,
        ingestKey: INGEST_KEY,
        sourceOrdinal: d.int(1),
        conversationIdentitySha256: alphaIdentity,
        messageIdentitySha256: message1Identity,
      },
    ], null);

    push("native-transcript-checkpoints", [
      {
        machineIdentityKey: MACHINE_A,
        clientName: "codex",
        sourceLocator: "/var/log/codex/alpha.jsonl",
        revision: d.int(4),
        lastSourceOrdinal: d.int(1),
        importedCount: d.int(2),
        skippedCount: d.int(1),
        quarantinedCount: d.int(0),
        checkpoint: jsonObject({ offset: 512, generation: "g1" }),
        updatedAt: d.timestamp(T.checkpoint),
      },
    ], { projectIdentity });
  }

  // Pending, applied, and quarantined passive events.
  push(
    "passive-events",
    passiveStates.map((state, index) => ({
      machineIdentityKey: MACHINE_A,
      eventId: state.eventId,
      eventVersion: d.int(1),
      machineSequence: d.int(index),
      eventType: "session.compacted",
      sessionId: SESSION_A,
      sessionSequence: d.int(index),
      category: "intent",
      data: "{\"summary\":\"compacted\"}",
      priority: d.int(index === 2 ? 0 : 5),
      sourceHook: "PreCompact",
      createdAt: d.timestamp(T.event),
      disposition:
        d.backend === "postgres"
          ? normalizePostgresDisposition(state.postgresState)
          : normalizeLocalDisposition(state.processedAt, state.deliveryState),
    })),
    { projectIdentity },
  );

  const finished = drafts.map((draft) =>
    options.mutate === undefined
      ? draft
      : { domain: draft.domain, values: options.mutate(draft.domain, draft.values), contexts: draft.contexts },
  );
  const byDomain = new Map(finished.map((draft) => [draft.domain, draft]));
  return PORTABLE_RECORD_DOMAIN_ORDER.map(
    (domain) => byDomain.get(domain) ?? { domain, values: [], contexts: [] },
  );
}
/* ------------------------------------------------------------------ *
 * Native transcript byte witnesses
 * ------------------------------------------------------------------ */

/** Canonical byte length of a native payload, derived independently. */
export function nativePayloadBytes(payload: JsonObject | readonly JsonValue[]): number {
  return Buffer.byteLength(independentCanonicalJson(payload), "utf8");
}

/**
 * Canonical byte length of the native metadata: the normalized value without
 * its payload.  The witness is computed over normalized portable scalars, not
 * the backend dialect spellings, because the codec canonicalizes first.
 */
export function nativeMetadataBytes(value: UnknownRecord, dialect: Dialect): number {
  const metadata: UnknownRecord = {
    machineIdentityKey: value.machineIdentityKey,
    clientName: value.clientName,
    formatName: value.formatName,
    formatVersion: value.formatVersion,
    nativeSessionId: value.nativeSessionId,
    sourceLocator: value.sourceLocator,
    sourceOrdinal: integer(normalizeIntForWitness(value.sourceOrdinal)),
    observedAt: canonicalizeTimestampForWitness(value.observedAt as string, dialect),
    ingestedAt: canonicalizeTimestampForWitness(value.ingestedAt as string, dialect),
    scrubberVersion: value.scrubberVersion,
    contentSha256: value.contentSha256,
    ingestKey: value.ingestKey,
  };
  return Buffer.byteLength(independentCanonicalJson(metadata), "utf8");
}

function normalizeIntForWitness(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return String(value);
  return String(value);
}

function canonicalizeTimestampForWitness(value: string, dialect: Dialect): string {
  if (dialect.backend === "postgres") return value;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(value);
  if (match === null) throw new Error("fixture SQLite timestamp is malformed: " + value);
  const fraction = (match[3] ?? "").padEnd(6, "0");
  return match[1] + "T" + match[2] + "." + fraction + "Z";
}

/* ------------------------------------------------------------------ *
 * Record construction
 * ------------------------------------------------------------------ */

/**
 * Turn one backend generation's drafts into the ordered per-domain portable
 * record inventory.  Ordinals are assigned per domain in the source's own
 * total order, exactly as a real adapter page would emit them.
 */
export function buildRecords(options: AdapterOptions): ReadonlyMap<PortableDomain, readonly PortableRecord[]> {
  const drafts = buildDomainDrafts(options);
  const result = new Map<PortableDomain, readonly PortableRecord[]>();
  for (const draft of drafts) {
    result.set(draft.domain, buildDomainRecords(draft));
  }
  assertRequiredDependenciesExist(result);
  assertSummaryDagAcyclic(result);
  return result;
}

/** A declared-shape adapter must not attest records whose required target is absent. */
function assertRequiredDependenciesExist(
  recordsByDomain: ReadonlyMap<PortableDomain, readonly PortableRecord[]>,
): void {
  const identities = new Map<PortableDomain, ReadonlySet<string>>();
  for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
    identities.set(
      domain,
      new Set((recordsByDomain.get(domain) ?? []).map((record) => record.identitySha256)),
    );
  }
  for (const records of recordsByDomain.values()) {
    for (const record of records) {
      for (const required of record.dependencies) {
        if (!(identities.get(required.domain) as ReadonlySet<string>).has(required.identitySha256)) {
          throw new Error("dangling required dependency in declared-shape fixture");
        }
      }
    }
  }
}

/** Summary parent rows are individually canonical, so cycle proof needs the full inventory. */
function assertSummaryDagAcyclic(
  recordsByDomain: ReadonlyMap<PortableDomain, readonly PortableRecord[]>,
): void {
  const parents = new Map<string, string[]>();
  for (const record of recordsByDomain.get("summary-parent-links") ?? []) {
    const value = record.value as PortableRecord["value"] & {
      readonly summaryId: string;
      readonly parentSummaryId: string;
    };
    const current = parents.get(value.summaryId);
    if (current === undefined) parents.set(value.summaryId, [value.parentSummaryId]);
    else current.push(value.parentSummaryId);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (summaryId: string): void => {
    if (visiting.has(summaryId)) throw new Error("summary DAG cycle in declared-shape fixture");
    if (visited.has(summaryId)) return;
    visiting.add(summaryId);
    for (const parent of parents.get(summaryId) ?? []) visit(parent);
    visiting.delete(summaryId);
    visited.add(summaryId);
  };
  for (const summaryId of parents.keys()) visit(summaryId);
}

/**
 * Build one domain's records in the portable total order.
 *
 * A source enumerates rows in its own physical order, so the adapter sorts by
 * the canonical order tuple and only then assigns contiguous zero-based
 * ordinals.  Records are therefore constructed twice: once to obtain their
 * canonical order tuples, and once at their final sorted position.
 */
export function buildDomainRecords(draft: DomainDraft): readonly PortableRecord[] {
  const probes = draft.values.map((value, index) => ({
    index,
    record: createRecord(draft, index, 0),
    value,
  }));
  probes.sort((left, right) => compareOrderArrays(left.record.order, right.record.order));
  return probes.map((probe, ordinal) => createRecord(draft, probe.index, ordinal));
}

function createRecord(draft: DomainDraft, index: number, ordinal: number): PortableRecord {
  return createPortableRecord({
    domain: draft.domain,
    ordinal,
    value: draft.values[index],
    context: draft.contexts[index],
  } as unknown as PortableRecordInput);
}

function compareOrderArrays(
  left: readonly unknown[],
  right: readonly unknown[],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const comparison = compareScalar(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function compareScalar(left: unknown, right: unknown): number {
  if (left === null) return right === null ? 0 : -1;
  if (right === null) return 1;
  if (typeof left === "string") {
    if (typeof right !== "string") return -1;
    return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
  }
  if (typeof right === "string") return 1;
  const a = BigInt((left as { $integer: string }).$integer);
  const b = BigInt((right as { $integer: string }).$integer);
  return a < b ? -1 : a > b ? 1 : 0;
}
/* ------------------------------------------------------------------ *
 * Coverage evidence and source descriptions
 * ------------------------------------------------------------------ */

/**
 * Every coverage entry is bound to a deterministic evidence payload derived
 * from the generation identity and the declared state.  Evidence is never a
 * free-form constant, so an adapter cannot mislabel a domain empty: the
 * authoritative-empty evidence preimage explicitly names the generation proof
 * that the architecture never stored the domain.
 */
export function coverageEvidence(
  generation: string,
  domain: PortableDomain,
  state: "available" | "authoritative-empty",
): PortableCoverageEvidence {
  if (state === "available") {
    return Object.freeze({
      state: "available" as const,
      evidenceSha256: independentSha256([
        "lcm-fixture-coverage-available-v1",
        generation,
        domain,
      ]),
    });
  }
  return Object.freeze({
    state: "authoritative-empty" as const,
    reason: "not-in-source-generation" as const,
    evidenceSha256: independentSha256([
      "lcm-fixture-coverage-authoritative-empty-v1",
      generation,
      domain,
      "generation-never-stored-this-domain",
    ]),
  });
}

export interface SourceOptions extends AdapterOptions {
  /** Distinguishes one authenticated source generation from another. */
  readonly generation: string;
  /** Domains this generation proves it never stored. */
  readonly authoritativeEmpty?: readonly PortableDomain[];
  /**
   * Only the isolated whole-manifest byte-equality protocol test may share a
   * deterministic source witness across two backends.  Everything else keeps
   * backend-specific source authentication facts.
   */
  readonly sharedWitness?: boolean;
  readonly capturedAt?: string;
}

export const CAPTURED_AT_SQLITE = "2026-08-13T13:00:00.000000Z";
export const CAPTURED_AT_POSTGRES = "2026-08-13T13:05:30.250000Z";
export const CAPTURED_AT_SHARED = "2026-08-13T13:10:00.000000Z";

export function buildSourceDescription(options: SourceOptions): PortableSourceDescription {
  const empty = new Set(options.authoritativeEmpty ?? []);
  const generation = options.sharedWitness === true ? "shared-protocol-generation" : options.generation;
  const coverage = Object.fromEntries(
    PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => [
      domain,
      coverageEvidence(generation, domain, empty.has(domain) ? "authoritative-empty" : "available"),
    ]),
  ) as Record<PortableDomain, PortableCoverageEvidence>;
  return Object.freeze({
    capturedAt:
      options.capturedAt
      ?? (options.sharedWitness === true
        ? CAPTURED_AT_SHARED
        : options.dialect.backend === "sqlite"
          ? CAPTURED_AT_SQLITE
          : CAPTURED_AT_POSTGRES),
    sourceIdentitySha256: independentSha256(["lcm-fixture-source-identity-v1", generation]),
    sourceWitnessSha256: independentSha256(["lcm-fixture-source-witness-v1", generation]),
    coverage: Object.freeze(coverage),
  });
}
/* ------------------------------------------------------------------ *
 * A bounded, deterministic record source
 * ------------------------------------------------------------------ */

export type VerifyResult = "unchanged" | "changed" | "invalid" | "unavailable";

export interface FixtureSourceOptions {
  readonly description: PortableSourceDescription;
  readonly records: ReadonlyMap<PortableDomain, readonly PortableRecord[]>;
  /** Page size used to prove cross-page adjacency and predecessor checks. */
  readonly pageSize?: number;
  readonly verify?: (
    input: PortableSourceVerificationInput,
    call: number,
  ) => VerifyResult | Promise<VerifyResult>;
  readonly describeOverride?: () => PortableSourceDescription;
  readonly readOverride?: (
    input: PortableSourcePageInput,
  ) => PortableSourcePage | Promise<PortableSourcePage> | undefined;
  readonly onClose?: () => void | Promise<void>;
}

export interface FixtureSource extends PortableRecordSource {
  readonly verifyCalls: () => number;
  readonly readCalls: () => readonly PortableSourcePageInput[];
  readonly closed: () => boolean;
}

/**
 * Serve the frozen record inventory as bounded pages.  The source never
 * retains cross-page state of its own: each page is derived from the ordinal
 * window the stream requests.
 */
export function createFixtureSource(options: FixtureSourceOptions): FixtureSource {
  const pageSize = options.pageSize ?? 500;
  let verifyCalls = 0;
  const readCalls: PortableSourcePageInput[] = [];
  let closed = false;

  return {
    describeSource(): PortableSourceDescription {
      return options.describeOverride === undefined
        ? options.description
        : options.describeOverride();
    },
    async readDomainPage(input: PortableSourcePageInput): Promise<PortableSourcePage> {
      readCalls.push(input);
      const override = options.readOverride?.(input);
      if (override !== undefined) return await override;
      const all = options.records.get(input.domain) ?? [];
      const slice = all.slice(input.afterOrdinal, input.afterOrdinal + pageSize);
      const predecessor = input.includePredecessor && input.afterOrdinal > 0
        ? all[input.afterOrdinal - 1]
        : null;
      return {
        predecessor: predecessor ?? null,
        records: slice,
        complete: input.afterOrdinal + slice.length >= all.length,
      };
    },
    async verifySource(input: PortableSourceVerificationInput): Promise<VerifyResult> {
      verifyCalls += 1;
      if (options.verify === undefined) return "unchanged";
      return await options.verify(input, verifyCalls);
    },
    async close(): Promise<void> {
      closed = true;
      await options.onClose?.();
    },
    verifyCalls: () => verifyCalls,
    readCalls: () => readCalls,
    closed: () => closed,
  };
}

/** Convenience: build both the inventory and its authenticated source. */
export function createGeneration(options: SourceOptions & { readonly pageSize?: number }): {
  readonly records: ReadonlyMap<PortableDomain, readonly PortableRecord[]>;
  readonly description: PortableSourceDescription;
  readonly source: FixtureSource;
} {
  const records = buildRecords(options);
  const description = buildSourceDescription(options);
  const source = createFixtureSource({
    description,
    records,
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
  });
  return { records, description, source };
}

/** The three declared generations used across the parity acceptance matrix. */
export const NATIVE_DOMAINS: readonly PortableDomain[] = Object.freeze([
  "native-transcripts",
  "native-transcript-message-links",
  "native-transcript-checkpoints",
]);

export function sqliteUnboundGeneration(pageSize?: number): SourceOptions & { pageSize?: number } {
  return {
    dialect: SQLITE_DIALECT,
    projectIdentity: LOCAL_PROJECT_IDENTITY,
    generation: "sqlite-unbound-local",
    ...(pageSize === undefined ? {} : { pageSize }),
  };
}

export function sqliteBoundGeneration(pageSize?: number): SourceOptions & { pageSize?: number } {
  return {
    dialect: SQLITE_DIALECT,
    projectIdentity: SHARED_PROJECT_IDENTITY,
    generation: "remote-bound",
    sharedWitness: true,
    ...(pageSize === undefined ? {} : { pageSize }),
  };
}

export function postgresGeneration(pageSize?: number): SourceOptions & { pageSize?: number } {
  return {
    dialect: POSTGRES_DIALECT,
    projectIdentity: SHARED_PROJECT_IDENTITY,
    generation: "remote-bound",
    sharedWitness: true,
    ...(pageSize === undefined ? {} : { pageSize }),
  };
}

export function sqliteLegacyGeneration(pageSize?: number): SourceOptions & { pageSize?: number } {
  return {
    dialect: SQLITE_DIALECT,
    projectIdentity: SHARED_PROJECT_IDENTITY,
    generation: "sqlite-legacy",
    legacyGeneration: true,
    authoritativeEmpty: NATIVE_DOMAINS,
    ...(pageSize === undefined ? {} : { pageSize }),
  };
}
