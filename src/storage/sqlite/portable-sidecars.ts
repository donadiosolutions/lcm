import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import { sqliteUtf8Projection, decodeSqliteUtf8Row } from "./portable-utf8.js";
import { PORTABLE_LIMITS, type PortableProjectIdentity } from "../portable-record.js";
import { PortableTransferError } from "../portable-transfer.js";
import type { SqliteRawDomainRow } from "./portable-runtime-mapping.js";

export type SqliteSidecarDomain = "passive-events" | "session-instructions";

/** Identity facts from the admitted captured generation, never live registration. */
export interface SqliteSidecarIdentity {
  readonly projectIdentity: PortableProjectIdentity;
  readonly sourceLocalProjectId?: string;
  readonly machineIdentityKey: string;
  readonly machineId: string | null;
}

type Row = Record<string, SQLOutputValue>;
type Field = readonly [field: string, column: string];
interface Mapping {
  readonly table: string;
  readonly key: string;
  readonly fields: readonly Field[];
}

const mappings: Record<SqliteSidecarDomain, Mapping> = {
  "passive-events": {
    table: "events", key: "event_id", fields: [
      ["eventId", "event_uuid"], ["eventVersion", "event_version"],
      ["machineSequence", "machine_sequence"], ["eventType", "type"],
      ["sessionId", "session_id"], ["sessionSequence", "seq"],
      ["category", "category"], ["data", "data"], ["priority", "priority"],
      ["sourceHook", "source_hook"], ["createdAt", "created_at"],
    ],
  },
  "session-instructions": {
    table: "session_instruction_cache", key: "scope_hash", fields: [
      ["scopeHash", "scope_hash"], ["clientName", "client_name"],
      ["sessionId", "session_id"], ["worktreePath", "worktree_path"],
      ["cwdPath", "cwd_path"], ["content", "content"],
      ["contentHash", "content_hash"], ["updatedAt", "updated_at"],
    ],
  },
};

function sizeExpression(mapping: Mapping, domain: SqliteSidecarDomain): string {
  const columns = new Set([mapping.key, ...mapping.fields.map(([, column]) => column)]);
  if (domain === "passive-events") columns.add("machine_id");
  return [...columns].map(column => `coalesce(length(CAST(${column} AS BLOB)),0)`).join("+");
}

/** Only canonical TEXT fields: never inspect operational reasons or leases. */
function nulExpression(mapping: Mapping, domain: SqliteSidecarDomain): string {
  const columns = new Set([mapping.key, ...mapping.fields.map(([, column]) => column),
    domain === "passive-events" ? "machine_id" : "project_id"]);
  return layouts[mapping.table].filter(([name, type]) => type === "TEXT" && columns.has(name))
    .map(([name]) => `coalesce(instr(${name},char(0)),0)>0`).join(" OR ");
}

function assertSize(row: Row): void {
  if (row.bytes as bigint > BigInt(PORTABLE_LIMITS.maxRecordBytes)) {
    throw new PortableTransferError("unsupported-capability");
  }
  if (row.nul === 1n) throw new PortableTransferError("unsupported-capability");
}

function timestamp(value: SQLOutputValue): string {
  if (typeof value !== "string") throw new PortableTransferError("unsupported-capability");
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z?$/.exec(value);
  if (match === null) throw new PortableTransferError("unsupported-capability");
  return `${match[1]}T${match[2]}.${(match[3] ?? "").padEnd(6, "0")}Z`;
}

function decode(mapping: Mapping, domain: SqliteSidecarDomain, row: Row, identity: SqliteSidecarIdentity): SqliteRawDomainRow {
  const value: Record<string, unknown> = { machineIdentityKey: identity.machineIdentityKey };
  for (const [field, column] of mapping.fields) value[field] = row[column];
  if (domain === "passive-events") {
    if ((row.machine_id !== null && row.machine_id !== identity.machineId)
      || typeof row.priority !== "bigint"
      || typeof row.machine_sequence !== "string"
      || !/^\d{19}$/.test(row.machine_sequence)) {
      throw new PortableTransferError("unsupported-capability");
    }
    value.machineSequence = BigInt(row.machine_sequence);
    value.createdAt = timestamp(row.created_at);
    value.disposition = row.disposition;
  } else value.updatedAt = timestamp(row.updated_at);
  return { locator: String(row[mapping.key]), value };
}

function scope(domain: SqliteSidecarDomain, identity: SqliteSidecarIdentity): { predicates: string[]; values: SQLInputValue[] } {
  return domain === "session-instructions"
    ? { predicates: ["project_id COLLATE BINARY=?"], values: [identity.sourceLocalProjectId ?? identity.projectIdentity.projectId] }
    : { predicates: [], values: [] };
}

function fail(error: unknown): never {
  if (error instanceof PortableTransferError) throw error;
  throw new PortableTransferError("source-failed");
}

/**
 * Reads one bounded row from an already admitted immutable, read-only sidecar.
 * The caller owns admission, generation stability, cancellation and connection life.
 */
export function readSqliteSidecarDomainRow(
  db: DatabaseSync,
  domain: SqliteSidecarDomain,
  locator: string,
  identity: SqliteSidecarIdentity,
): SqliteRawDomainRow | undefined {
  try {
    const mapping = mappings[domain];
    const { predicates, values } = scope(domain, identity);
    predicates.push(`${mapping.key}${domain === "session-instructions" ? " COLLATE BINARY" : ""}=?`);
    values.push(locator);
    const from = ` FROM ${mapping.table} WHERE ${predicates.join(" AND ")}`;
    const metadata = db.prepare(`SELECT (${nulExpression(mapping, domain)}) AS nul, ${sizeExpression(mapping, domain)} AS bytes${from}`);
    metadata.setReadBigInts(true);
    const header = metadata.get(...values);
    if (header === undefined) return undefined;
    assertSize(header);
    const columns = new Set([mapping.key, ...mapping.fields.map(([, column]) => column)]);
    let disposition = "";
    if (domain === "passive-events") {
      columns.add("machine_id");
      // Evaluate disposition in SQL so operational payload/lease/reason values
      // never cross the driver boundary or become imported execution authority.
      disposition = ", CASE WHEN processed_at IS NOT NULL OR delivery_state='acknowledged' THEN 'applied' WHEN delivery_state='quarantined' THEN 'quarantined' ELSE 'pending' END AS disposition";
    }
    const statement = db.prepare(`SELECT ${sqliteUtf8Projection([...columns])}${disposition}${from}`);
    statement.setReadBigInts(true);
    const row = statement.get(...values);
    if (row === undefined) throw new PortableTransferError("source-failed");
    return decode(mapping, domain, decodeSqliteUtf8Row(row, [...columns]), identity);
  } catch (error) { fail(error); }
}

/** Physical keyset order; the owning canonical index supplies portable ordering. */
export function* iterateSqliteSidecarDomainRows(
  db: DatabaseSync,
  domain: SqliteSidecarDomain,
  identity: SqliteSidecarIdentity,
): Generator<SqliteRawDomainRow> {
  try {
    const mapping = mappings[domain];
    const bytes = sizeExpression(mapping, domain);
    const nul = nulExpression(mapping, domain);
    let after: SQLInputValue | undefined;
    for (;;) {
      const { predicates, values } = scope(domain, identity);
      if (after !== undefined) { predicates.push(`${mapping.key}${domain === "session-instructions" ? " COLLATE BINARY" : ""}>?`); values.push(after); }
      const where = predicates.length === 0 ? "" : ` WHERE ${predicates.join(" AND ")}`;
      // CASE also bounds the physical key itself before it enters JavaScript.
      const metadata = db.prepare(`SELECT ${sqliteUtf8Projection(["locator"])}, nul, bytes FROM (SELECT CASE WHEN ${bytes}<=${PORTABLE_LIMITS.maxRecordBytes} AND NOT (${nul}) THEN ${mapping.key} END AS locator, (${nul}) AS nul, ${bytes} AS bytes FROM ${mapping.table}${where} ORDER BY ${mapping.key}${domain === "session-instructions" ? " COLLATE BINARY" : ""} LIMIT 500)`);
      metadata.setReadBigInts(true);
      const page = metadata.all(...values);
      if (page.length === 0) return;
      for (const rawHeader of page) {
        assertSize(rawHeader);
        const header = decodeSqliteUtf8Row(rawHeader, ["locator"]);
        const row = readSqliteSidecarDomainRow(db, domain, String(header.locator), identity);
        if (row === undefined) throw new PortableTransferError("source-failed");
        yield row;
        after = header.locator;
      }
    }
  } catch (error) { fail(error); }
}

// Exact current layouts. Operational runtime error/parking data has no portable
// counterpart, but its schema must still be known before it can be omitted.
type Column = readonly [name: string, type: "TEXT" | "INTEGER", notnull: number, pk: number];
const layouts: Record<string, readonly Column[]> = {
  events: [
    ["event_id", "INTEGER", 0, 1], ["event_uuid", "TEXT", 1, 0],
    ["event_version", "INTEGER", 1, 0], ["machine_id", "TEXT", 0, 0],
    ["machine_sequence", "TEXT", 1, 0], ["session_id", "TEXT", 1, 0],
    ["seq", "INTEGER", 1, 0], ["type", "TEXT", 1, 0],
    ["category", "TEXT", 1, 0], ["data", "TEXT", 1, 0],
    ["priority", "INTEGER", 0, 0], ["source_hook", "TEXT", 1, 0],
    ["prev_event_id", "INTEGER", 0, 0], ["processed_at", "TEXT", 0, 0],
    ["created_at", "TEXT", 1, 0], ["delivery_state", "TEXT", 1, 0],
    ["delivery_generation", "INTEGER", 1, 0], ["delivery_attempts", "INTEGER", 1, 0],
    ["delivery_owner", "TEXT", 0, 0], ["delivery_claimed_at", "TEXT", 0, 0],
    ["delivery_next_attempt_at", "TEXT", 1, 0], ["delivery_last_error", "TEXT", 0, 0],
    ["remote_inbox_id", "TEXT", 0, 0], ["quarantine_reason", "TEXT", 0, 0],
    ["acknowledged_at", "TEXT", 0, 0], ["remote_pruned_at", "TEXT", 0, 0],
    ["delivery_updated_at", "TEXT", 1, 0],
  ],
  error_log: [
    ["id", "INTEGER", 0, 1], ["hook", "TEXT", 1, 0], ["error", "TEXT", 1, 0],
    ["session_id", "TEXT", 0, 0], ["created_at", "TEXT", 0, 0],
  ],
  missing_cwd_state: [
    ["id", "INTEGER", 0, 1], ["observations", "INTEGER", 1, 0],
    ["last_observed_at", "INTEGER", 1, 0], ["parked_at", "TEXT", 0, 0],
  ],
  schema_version: [["version", "INTEGER", 1, 0]],
  session_instruction_cache: [
    ["project_id", "TEXT", 1, 1], ["scope_hash", "TEXT", 1, 2],
    ["client_name", "TEXT", 1, 0], ["session_id", "TEXT", 1, 0],
    ["worktree_path", "TEXT", 1, 0], ["cwd_path", "TEXT", 1, 0],
    ["content", "TEXT", 1, 0], ["content_hash", "TEXT", 1, 0],
    ["updated_at", "TEXT", 1, 0],
  ],
};

/**
 * Admission for a dedicated captured sidecar, called once by the source opener.
 * An instruction cache inside a complete main database uses main-schema admission.
 * This checks supported physical layouts without migrating or repairing anything.
 */
export function validateSqliteSidecarSchema(db: DatabaseSync, domain: SqliteSidecarDomain): void {
  try {
    const tables = domain === "passive-events"
      ? ["events", "error_log", "missing_cwd_state", "schema_version"]
      : ["session_instruction_cache"];
    const version = db.prepare("PRAGMA user_version").get()!;
    if (version.user_version !== 0) throw new PortableTransferError("unsupported-capability");
    // Names/row count are bounded even for an unsupported captured schema.
    const objects = db.prepare(`SELECT CASE WHEN length(CAST(name AS BLOB))<=64 THEN name END AS name, type FROM sqlite_schema WHERE type IN ('table','view','trigger') AND name NOT IN ('sqlite_sequence','sqlite_stat1','sqlite_stat4') LIMIT ${tables.length + 1}`).all();
    if (objects.length !== tables.length || objects.some(row => row.type !== "table" || !tables.includes(row.name as string))) {
      throw new PortableTransferError("unsupported-capability");
    }
    for (const table of tables) {
      const expected = layouts[table];
      const columns = db.prepare(`SELECT CASE WHEN length(CAST(name AS BLOB))<=64 THEN name END AS name, CASE WHEN length(CAST(type AS BLOB))<=16 THEN type END AS type, "notnull", pk, hidden FROM pragma_table_xinfo(?) LIMIT ${expected.length + 1}`).all(table);
      if (columns.length !== expected.length || columns.some((column, index) => {
        const [name, type, notnull, pk] = expected[index];
        return column.name !== name || column.type !== type || column.notnull !== notnull || column.pk !== pk || column.hidden !== 0;
      })) throw new PortableTransferError("unsupported-capability");
    }
    const mapping = mappings[domain];
    if (db.prepare(`SELECT 1 FROM ${mapping.table} WHERE ${nulExpression(mapping, domain)} LIMIT 1`).get() !== undefined) {
      throw new PortableTransferError("unsupported-capability");
    }
    if (domain === "passive-events") {
      const statement = db.prepare("SELECT version FROM schema_version LIMIT 2");
      statement.setReadBigInts(true);
      const versions = statement.all();
      if (versions.length !== 1 || versions[0].version !== 5n) throw new PortableTransferError("unsupported-capability");
    }
  } catch (error) { fail(error); }
}
