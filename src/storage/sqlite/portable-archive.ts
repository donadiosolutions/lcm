import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { sqliteUtf8Projection, decodeSqliteUtf8Row } from "./portable-utf8.js";
import { PortableTransferError, normalizePortableTransferError } from "../portable-transfer.js";
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import {
  PORTABLE_LIMITS, PortableStreamError, canonicalJson, canonicalSha256,
  type PortableDomain, type PortableIntegerValue, type PortableRawInteger,
  type PortableRawRecordValueByDomain, type PortableRecord, type PortableRecordValueByDomain,
} from "../portable-record.js";

/** Recovery facts in one owned generation. These tables are never live ingest state. */
export const PORTABLE_ARCHIVE_DOMAINS = [
  "machines", "project", "project-aliases", "session-instructions", "native-transcripts",
  "native-transcript-message-links", "native-transcript-checkpoints", "passive-events",
] as const;
export type PortableArchiveDomain = typeof PORTABLE_ARCHIVE_DOMAINS[number];

type Column = readonly [name: string, kind: "text" | "nullable" | "integer" | "json"];
type Definition = Readonly<{ columns: readonly Column[]; unique: readonly string[] }>;
const definitions: Record<PortableArchiveDomain, Definition> = {
  machines: { columns: [["identityKey", "text"], ["machineId", "nullable"]], unique: ["identityKey"] },
  project: { columns: [["scope", "text"], ["projectId", "text"]], unique: ["scope", "projectId"] },
  "project-aliases": {
    columns: [["machineIdentityKey", "text"], ["path", "text"], ["normalizedPath", "text"]],
    unique: ["machineIdentityKey", "normalizedPath"],
  },
  "session-instructions": {
    columns: [["machineIdentityKey", "text"], ["scopeHash", "text"], ["clientName", "text"], ["sessionId", "text"],
      ["worktreePath", "text"], ["cwdPath", "text"], ["content", "text"], ["contentHash", "text"], ["updatedAt", "text"]],
    unique: ["machineIdentityKey", "scopeHash"],
  },
  "native-transcripts": {
    columns: [["machineIdentityKey", "text"], ["clientName", "text"], ["formatName", "text"], ["formatVersion", "text"],
      ["nativeSessionId", "text"], ["sourceLocator", "text"], ["sourceOrdinal", "integer"], ["observedAt", "text"],
      ["ingestedAt", "text"], ["scrubberVersion", "text"], ["contentSha256", "text"], ["ingestKey", "text"], ["nativePayload", "json"]],
    unique: ["machineIdentityKey", "ingestKey"],
  },
  "native-transcript-message-links": {
    columns: [["machineIdentityKey", "text"], ["ingestKey", "text"], ["sourceOrdinal", "integer"],
      ["conversationIdentitySha256", "text"], ["messageIdentitySha256", "text"], ["_transcript_identity_sha256", "text"]],
    unique: ["machineIdentityKey", "ingestKey", "sourceOrdinal"],
  },
  "native-transcript-checkpoints": {
    columns: [["machineIdentityKey", "text"], ["clientName", "text"], ["sourceLocator", "text"], ["revision", "integer"],
      ["lastSourceOrdinal", "integer"], ["importedCount", "integer"], ["skippedCount", "integer"], ["quarantinedCount", "integer"],
      ["checkpoint", "json"], ["updatedAt", "text"]],
    unique: ["machineIdentityKey", "clientName", "sourceLocator"],
  },
  "passive-events": {
    columns: [["machineIdentityKey", "text"], ["eventId", "text"], ["eventVersion", "integer"], ["machineSequence", "integer"],
      ["eventType", "text"], ["sessionId", "text"], ["sessionSequence", "integer"], ["category", "text"], ["data", "text"],
      ["priority", "integer"], ["sourceHook", "text"], ["createdAt", "text"], ["disposition", "text"]],
    unique: ["machineIdentityKey", "machineSequence"],
  },
};
function definition(domain: PortableDomain): Definition {
  if (!Object.hasOwn(definitions, domain)) throw new PortableStreamError("unknown-domain");
  return definitions[domain as PortableArchiveDomain];
}
function table(domain: PortableDomain): string {
  definition(domain);
  return `portable_archive_${domain.replaceAll("-", "_")}`;
}
function names(columns: readonly Column[]): string { return columns.map(([name]) => `"${name}"`).join(", "); }

/** Internal schema initializer: caller must already own the isolated database. */
export function initializePortableArchive(db: DatabaseSync): void {
  for (const domain of PORTABLE_ARCHIVE_DOMAINS) {
    const { columns, unique } = definition(domain);
    db.exec(`CREATE TABLE IF NOT EXISTS ${table(domain)} (
      _ordinal INTEGER PRIMARY KEY CHECK (_ordinal >= 0),
      _identity_sha256 TEXT NOT NULL UNIQUE,
      ${columns.map(([name, kind]) => `"${name}" ${kind === "integer" ? "INTEGER" : "TEXT"}${kind === "nullable" ? "" : " NOT NULL"}`).join(", ")},
      UNIQUE (${unique.map(name => `"${name}"`).join(", ")})
    ) STRICT`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS portable_archive_transcript_links_lookup ON portable_archive_native_transcript_message_links (_transcript_identity_sha256, sourceOrdinal)");
}

/** Internal insert only; the canonical writer supplies validation and its batch transaction. */
export function writePortableArchiveRecord(db: DatabaseSync, record: PortableRecord): void {
  const { columns } = definition(record.domain);
  const value = record.value as unknown as Record<string, unknown>;
  const source = record.domain === "project" ? value.identity as Record<string, unknown> : value;
  const values = columns.map(([name, kind]): SQLInputValue => {
    if (name === "_transcript_identity_sha256") {
      return canonicalSha256(["lcm-portable-identity-v1", "native-transcripts", [value.machineIdentityKey, value.ingestKey]]);
    }
    if (kind === "integer") return BigInt((source[name] as PortableIntegerValue).$integer);
    if (kind === "json") return canonicalJson(source[name]);
    return source[name] as string | null;
  });
  db.prepare(`INSERT INTO ${table(record.domain)} (_ordinal, _identity_sha256, ${names(columns)})
    VALUES (?, ?, ${columns.map(() => "?").join(", ")})`).run(record.ordinal, record.identitySha256, ...values);
}

export interface PortableArchiveRow<D extends PortableArchiveDomain> {
  readonly physicalIdentityKey: string;
  readonly value: PortableRawRecordValueByDomain[D];
}
type Row = Record<string, SQLOutputValue>;
function decode<D extends PortableArchiveDomain>(domain: D, row: Row, tagged: boolean): PortableRawRecordValueByDomain[D] | PortableRecordValueByDomain[D] {
  if (domain === "project") return { identity: { scope: row.scope, projectId: row.projectId } } as PortableRecordValueByDomain[D];
  const result: Record<string, unknown> = {};
  for (const [name, kind] of definition(domain).columns) {
    if (name === "_transcript_identity_sha256") continue;
    const value = row[name];
    result[name] = kind === "json" ? JSON.parse(value as string) as unknown
      : kind === "integer" && tagged ? { $integer: String(value) } : value;
  }
  return result as PortableRawRecordValueByDomain[D] | PortableRecordValueByDomain[D];
}

/** Measure actual SQL content, including UTF-8 bytes, before fetching any large field. */
function byteExpression(domain: PortableArchiveDomain): string {
  return ["_identity_sha256", ...definition(domain).columns.map(([name]) => name)]
    .map(name => `coalesce(length(CAST("${name}" AS BLOB)), 0)`).join(" + ");
}
// Check stored TEXT before node:sqlite can silently truncate it at U+0000.
// JSON escapes contain no actual NUL and remain available to the canonical codec.
function nulExpression(domain: PortableArchiveDomain): string {
  return ["_identity_sha256", ...definition(domain).columns.filter(([, kind]) => kind !== "integer").map(([name]) => name)]
    .map(name => `coalesce(instr("${name}",char(0)),0)>0`).join(" OR ");
}
function checkRowBytes(meta: Row): void {
  const bytes = meta._bytes;
  if (BigInt(bytes as number | bigint) > BigInt(PORTABLE_LIMITS.maxRecordBytes)) {
    throw new PortableStreamError("record-unrepresentable");
  }
  if (meta._nul === 1n) throw new PortableTransferError("unsupported-capability");
}
function fetchRow(db: DatabaseSync, domain: PortableArchiveDomain, ordinal: SQLInputValue): Row {
  const columns = ["_identity_sha256", ...definition(domain).columns.map(([name]) => name)];
  const statement = db.prepare(`SELECT ${sqliteUtf8Projection(columns)} FROM ${table(domain)} WHERE _ordinal = ?`);
  statement.setReadBigInts(true);
  const row = statement.get(ordinal);
  if (!row) throw new PortableStreamError("source-changed");
  return decodeSqliteUtf8Row(row, columns);
}

/** Internal source read. SQL itself is bounded; no archive domain is collected in memory. */
export function* readArchiveDomain<D extends PortableArchiveDomain>(db: DatabaseSync, domain: D): Generator<PortableArchiveRow<D>> {
  let after: SQLInputValue = -1;
  for (;;) {
    const statement = db.prepare(`SELECT _ordinal, ${byteExpression(domain)} AS _bytes, (${nulExpression(domain)}) AS _nul FROM ${table(domain)} WHERE _ordinal > ? ORDER BY _ordinal LIMIT 500`);
    statement.setReadBigInts(true);
    let count = 0;
    for (const meta of statement.iterate(after)) {
      checkRowBytes(meta);
      const row = fetchRow(db, domain, meta._ordinal);
      yield { physicalIdentityKey: row._identity_sha256 as string, value: decode(domain, row, false) as PortableRawRecordValueByDomain[D] };
      after = meta._ordinal;
      count++;
    }
    if (count < 500) return;
  }
}

/** Internal point reread for an authenticated source's disk-backed ordering index. */
export function readArchiveDomainRow<D extends PortableArchiveDomain>(db: DatabaseSync, domain: D, physicalIdentityKey: string): PortableArchiveRow<D> | undefined {
  const statement = db.prepare(`SELECT _ordinal, ${byteExpression(domain)} AS _bytes, (${nulExpression(domain)}) AS _nul FROM ${table(domain)} WHERE _identity_sha256 = ?`);
  statement.setReadBigInts(true);
  const meta = statement.get(physicalIdentityKey);
  if (!meta) return undefined;
  checkRowBytes(meta);
  const row = fetchRow(db, domain, meta._ordinal);
  return { physicalIdentityKey: row._identity_sha256 as string, value: decode(domain, row, false) as PortableRawRecordValueByDomain[D] };
}

type IntegerCursor = PortableRawInteger | PortableIntegerValue;
interface ReadOptions { readonly signal?: AbortSignal; readonly maxBytes?: number }
interface PageOptions extends ReadOptions { readonly limit: number }
interface MachinePageOptions extends PageOptions { readonly machineIdentityKey: string }
export interface SqlitePortableArchiveReader {
  getProject(options?: ReadOptions): Promise<PortableRecordValueByDomain["project"] | undefined>;
  listMachines(options: PageOptions & { readonly afterIdentityKey?: string }): Promise<readonly PortableRecordValueByDomain["machines"][]>;
  listProjectAliases(options: MachinePageOptions & { readonly afterNormalizedPath?: string }): Promise<readonly PortableRecordValueByDomain["project-aliases"][]>;
  getNativeTranscript(options: ReadOptions & { readonly machineIdentityKey: string; readonly ingestKey: string }): Promise<PortableRecordValueByDomain["native-transcripts"] | undefined>;
  listNativeTranscripts(options: MachinePageOptions & { readonly after?: string }): Promise<readonly PortableRecordValueByDomain["native-transcripts"][]>;
  listNativeTranscriptLinks(options: PageOptions & { readonly transcriptIdentitySha256: string; readonly afterSourceOrdinal?: IntegerCursor }): Promise<readonly PortableRecordValueByDomain["native-transcript-message-links"][]>;
  getNativeCheckpoint(options: ReadOptions & { readonly machineIdentityKey: string; readonly clientName: string; readonly sourceLocator: string }): Promise<PortableRecordValueByDomain["native-transcript-checkpoints"] | undefined>;
  listSessionInstructions(options: MachinePageOptions & { readonly afterScopeHash?: string }): Promise<readonly PortableRecordValueByDomain["session-instructions"][]>;
  listPassiveEvents(options: MachinePageOptions & { readonly afterMachineSequence?: IntegerCursor }): Promise<readonly PortableRecordValueByDomain["passive-events"][]>;
}
function cursor(value: IntegerCursor): bigint {
  try {
    const raw = typeof value === "object" ? value.$integer : value;
    if (typeof raw === "number" && !Number.isSafeInteger(raw)) throw new Error();
    if (typeof raw === "string" && !/^(0|[1-9][0-9]*)$/u.test(raw)) throw new Error();
    const parsed = BigInt(raw);
    if (parsed < 0n || parsed > 9223372036854775807n) throw new Error();
    return parsed;
  } catch { throw new PortableTransferError("invalid-input"); }
}
function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PortableStreamError("aborted");
}

/**
 * Internal factory. The opener binds this database to one generation/project and
 * supplies its revocable authority check; retaining a reader never retains authority.
 */
export function createSqlitePortableArchiveReader(
  db: DatabaseSync,
  guard: (signal?: AbortSignal) => void | Promise<void>,
): SqlitePortableArchiveReader {
  async function check(signal?: AbortSignal): Promise<void> {
    abort(signal);
    await guard(signal);
    await yieldToEventLoop();
    abort(signal);
  }
  async function readPage<D extends PortableArchiveDomain>(
    domain: D, options: PageOptions, where: string, parameters: SQLInputValue[], order: string,
  ): Promise<readonly PortableRecordValueByDomain[D][]> {
    await check(options.signal);
    const maxBytes = options.maxBytes ?? PORTABLE_LIMITS.maxBatchBytes;
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 500
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PORTABLE_LIMITS.maxBatchBytes) {
      throw new PortableStreamError("invalid-limit");
    }
    const statement = db.prepare(`SELECT _ordinal, ${byteExpression(domain)} AS _bytes, length(CAST(_identity_sha256 AS BLOB)) AS _identity_bytes, (${nulExpression(domain)}) AS _nul FROM ${table(domain)} WHERE ${where} ORDER BY ${order} LIMIT ?`);
    statement.setReadBigInts(true);
    const result: PortableRecordValueByDomain[D][] = [];
    let bytes = 0;
    for (const meta of statement.iterate(...parameters, options.limit)) {
      await check(options.signal);
      checkRowBytes(meta);
      // The physical identity is bounded above but is absent from canonical output.
      // Compare only the payload lower bound with the requested page budget.
      if (BigInt(meta._bytes as bigint) - BigInt(meta._identity_bytes as bigint) > BigInt(maxBytes - bytes)) {
        if (result.length === 0) throw new PortableStreamError("record-unrepresentable");
        break;
      }
      const value = decode(domain, fetchRow(db, domain, meta._ordinal), true) as PortableRecordValueByDomain[D];
      const size = Buffer.byteLength(canonicalJson(value));
      if (size > PORTABLE_LIMITS.maxRecordBytes || size > maxBytes - bytes) {
        if (result.length === 0) throw new PortableStreamError("record-unrepresentable");
        break;
      }
      result.push(value);
      bytes += size;
    }
    await check(options.signal);
    return result;
  }
  async function page<D extends PortableArchiveDomain>(
    domain: D, options: PageOptions, where: string, parameters: SQLInputValue[], order: string,
  ): Promise<readonly PortableRecordValueByDomain[D][]> {
    try { return await readPage(domain, options, where, parameters, order); }
    catch (error) { throw normalizePortableTransferError(error, "source-failed"); }
  }
  function machinePage<D extends PortableArchiveDomain>(
    domain: D, options: MachinePageOptions, key: string, after?: SQLInputValue,
  ) {
    return page(domain, options, `machineIdentityKey = ?${after === undefined ? "" : ` AND ${key} > ?`}`,
      after === undefined ? [options.machineIdentityKey] : [options.machineIdentityKey, after], key);
  }
  return {
    async getProject(options = {}) { return (await page("project", { ...options, limit: 1 }, "1", [], "_ordinal"))[0]; },
    listMachines(options) {
      return page("machines", options, options.afterIdentityKey === undefined ? "1" : "identityKey > ?",
        options.afterIdentityKey === undefined ? [] : [options.afterIdentityKey], "identityKey");
    },
    listProjectAliases(options) { return machinePage("project-aliases", options, "normalizedPath", options.afterNormalizedPath); },
    async getNativeTranscript(options) {
      return (await page("native-transcripts", { ...options, limit: 1 }, "machineIdentityKey = ? AND ingestKey = ?", [options.machineIdentityKey, options.ingestKey], "_ordinal"))[0];
    },
    listNativeTranscripts(options) { return machinePage("native-transcripts", options, "ingestKey", options.after); },
    async listNativeTranscriptLinks(options) {
      const after = options.afterSourceOrdinal === undefined ? undefined : cursor(options.afterSourceOrdinal);
      return page("native-transcript-message-links", options,
        `_transcript_identity_sha256 = ?${after === undefined ? "" : " AND sourceOrdinal > ?"}`,
        after === undefined ? [options.transcriptIdentitySha256] : [options.transcriptIdentitySha256, after], "sourceOrdinal");
    },
    async getNativeCheckpoint(options) {
      return (await page("native-transcript-checkpoints", { ...options, limit: 1 }, "machineIdentityKey = ? AND clientName = ? AND sourceLocator = ?",
        [options.machineIdentityKey, options.clientName, options.sourceLocator], "_ordinal"))[0];
    },
    listSessionInstructions(options) { return machinePage("session-instructions", options, "scopeHash", options.afterScopeHash); },
    async listPassiveEvents(options) {
      return machinePage("passive-events", options, "machineSequence", options.afterMachineSequence === undefined ? undefined : cursor(options.afterMachineSequence));
    },
  };
}
