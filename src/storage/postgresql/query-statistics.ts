import type { QueryConfig, QueryResultRow } from "pg";
import { PostgreSqlStorageOperationError } from "./errors.js";
import type { PostgreSqlQueryExecutor } from "./contracts.js";
import { QUERY_OPERATION_CATALOG } from "./query-operations.js";

export const MAX_OPERATIONS = 64;
export const MAX_MAPPING_PROBES = 16;
export const MAX_CANDIDATE_ROWS = 64;
export const MAX_COMPARISON_ENTRIES = 64;
export const MAX_CONTEXTS = 1;
const MAX_PLAN_BYTES = 256 * 1024;
const MAX_SAFE_COUNTER = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_QUERY_ID = -9_223_372_036_854_775_808n;
const MAX_QUERY_ID = 9_223_372_036_854_775_807n;
const SERVER_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;

export const QUERY_STATISTIC_METRICS = [
  "queryCallsTotal", "queryRowsTotal", "queryExecTimeTotalMs",
  "queryExecTimeMinMs", "queryExecTimeMaxMs", "queryExecTimeMeanMs",
  "queryExecTimeStddevMs", "queryPlanTimeTotalMs",
  "querySharedBlksHitTotal", "querySharedBlksReadTotal",
  "querySharedBlksDirtiedTotal", "querySharedBlksWrittenTotal",
  "queryLocalBlksHitTotal", "queryLocalBlksReadTotal",
  "queryLocalBlksDirtiedTotal", "queryLocalBlksWrittenTotal",
  "queryTempBlksReadTotal", "queryTempBlksWrittenTotal",
  "querySharedBlkReadTimeMs", "querySharedBlkWriteTimeMs",
  "queryWalRecordsTotal", "queryWalBytesTotal",
] as const;

export type QueryStatisticMetric = (typeof QUERY_STATISTIC_METRICS)[number];
export type QueryStatisticsStatus =
  | "not-applicable" | "disabled" | "unavailable" | "permission-denied"
  | "timeout" | "stale" | "reset" | "partial" | "observed";
export type QueryStatisticOmission =
  | "unavailable" | "timeout" | "permission-denied" | "out-of-range"
  | "reset" | "disabled-setting" | "no-entry" | "no-baseline";

export interface QueryStatisticOperation {
  readonly operation: string;
  readonly values: Partial<Record<QueryStatisticMetric, number>>;
  readonly omitted: Partial<Record<QueryStatisticMetric, QueryStatisticOmission>>;
}

export interface QueryStatisticsFamily {
  readonly status: QueryStatisticsStatus;
  readonly observedAt: number;
  readonly scope: "aggregate";
  readonly statementsDeallocTotal?: number;
  readonly statementsStatsReset?: string;
  readonly blockSize?: number;
  readonly omitted?: Partial<Record<
    "statementsDeallocTotal" | "statementsStatsReset" | "blockSize",
    QueryStatisticOmission
  >>;
  readonly operations?: readonly QueryStatisticOperation[];
}

export interface QueryStatisticsObservation {
  readonly family: QueryStatisticsFamily;
  commit(): boolean;
}

interface QueryStatisticsLimits {
  readonly maxOperations: number;
  readonly maxMappingProbes: number;
  readonly maxCandidateRows: number;
  readonly maxComparisonEntries: number;
}

export interface QueryStatisticsCollectOptions {
  readonly publicationWitness: string;
  readonly signal?: AbortSignal;
  readonly observedAt?: number;
  readonly _limits?: Partial<QueryStatisticsLimits>;
}

type FailureStatus = "permission-denied" | "timeout" | "unavailable";
type ContextRow = QueryResultRow & {
  track: unknown;
  track_planning: unknown;
  track_io_timing: unknown;
  block_size: unknown;
  role_oid: unknown;
  database_oid: unknown;
  postmaster_start: unknown;
  stats_reset: unknown;
  dealloc: unknown;
};
type StatisticRow = QueryResultRow & Record<string, unknown> & {
  queryid: unknown;
  postmaster_start: unknown;
  stats_reset: unknown;
  stats_since: unknown;
  minmax_stats_since: unknown;
};

type StoredCounter = bigint | number;
interface StoredEntry {
  readonly operation: string;
  readonly queryid: string;
  readonly statsSince: string;
  readonly minmaxStatsSince: string;
  readonly initialized: boolean;
  readonly absent: boolean;
  readonly counters: Readonly<Record<string, StoredCounter>>;
}
interface ComparisonContext {
  readonly key: string;
  readonly postmasterStart: string;
  readonly statsReset: string | null;
  readonly entries: ReadonlyMap<string, StoredEntry>;
}

const INTEGER_SOURCES = {
  queryCallsTotal: "calls", queryRowsTotal: "rows",
  querySharedBlksHitTotal: "shared_blks_hit",
  querySharedBlksReadTotal: "shared_blks_read",
  querySharedBlksDirtiedTotal: "shared_blks_dirtied",
  querySharedBlksWrittenTotal: "shared_blks_written",
  queryLocalBlksHitTotal: "local_blks_hit",
  queryLocalBlksReadTotal: "local_blks_read",
  queryLocalBlksDirtiedTotal: "local_blks_dirtied",
  queryLocalBlksWrittenTotal: "local_blks_written",
  queryTempBlksReadTotal: "temp_blks_read",
  queryTempBlksWrittenTotal: "temp_blks_written",
  queryWalRecordsTotal: "wal_records", queryWalBytesTotal: "wal_bytes",
} as const;
const FLOAT_SOURCES = {
  queryExecTimeTotalMs: "total_exec_time",
  queryPlanTimeTotalMs: "total_plan_time",
  querySharedBlkReadTimeMs: "shared_blk_read_time",
  querySharedBlkWriteTimeMs: "shared_blk_write_time",
} as const;
const MONOTONIC_SOURCES = [
  ...Object.values(INTEGER_SOURCES), ...Object.values(FLOAT_SOURCES),
] as const;

const CONTEXT_SQL = `SELECT
  pg_catalog.current_setting('pg_stat_statements.track', true) AS track,
  pg_catalog.current_setting('pg_stat_statements.track_planning', true) AS track_planning,
  pg_catalog.current_setting('track_io_timing', true) AS track_io_timing,
  pg_catalog.current_setting('block_size', true) AS block_size,
  (SELECT oid::pg_catalog.text FROM pg_catalog.pg_roles
    WHERE rolname OPERATOR(pg_catalog.=) CURRENT_USER) AS role_oid,
  (SELECT oid::pg_catalog.text FROM pg_catalog.pg_database
    WHERE datname OPERATOR(pg_catalog.=) pg_catalog.current_database()) AS database_oid,
  pg_catalog.to_char(pg_catalog.pg_postmaster_start_time() AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS postmaster_start,
  (SELECT pg_catalog.to_char(stats_reset AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM public.pg_stat_statements_info) AS stats_reset,
  (SELECT dealloc::pg_catalog.text FROM public.pg_stat_statements_info) AS dealloc`;

const ROWS_SQL = `WITH epoch AS MATERIALIZED (
  SELECT pg_catalog.to_char(pg_catalog.pg_postmaster_start_time() AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS postmaster_start,
         (SELECT pg_catalog.to_char(stats_reset AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM public.pg_stat_statements_info) AS stats_reset
), candidates AS MATERIALIZED (
  SELECT queryid::pg_catalog.text, calls::pg_catalog.text, rows::pg_catalog.text,
         total_exec_time, min_exec_time, max_exec_time, mean_exec_time,
         stddev_exec_time, total_plan_time,
         shared_blks_hit::pg_catalog.text, shared_blks_read::pg_catalog.text,
         shared_blks_dirtied::pg_catalog.text, shared_blks_written::pg_catalog.text,
         local_blks_hit::pg_catalog.text, local_blks_read::pg_catalog.text,
         local_blks_dirtied::pg_catalog.text, local_blks_written::pg_catalog.text,
         temp_blks_read::pg_catalog.text, temp_blks_written::pg_catalog.text,
         shared_blk_read_time, shared_blk_write_time,
         wal_records::pg_catalog.text, wal_bytes::pg_catalog.text,
         pg_catalog.to_char(stats_since AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stats_since,
         pg_catalog.to_char(minmax_stats_since AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS minmax_stats_since
  FROM public.pg_stat_statements(false)
  WHERE toplevel
    AND userid OPERATOR(pg_catalog.=) $1::pg_catalog.oid
    AND dbid OPERATOR(pg_catalog.=) $2::pg_catalog.oid
    AND queryid OPERATOR(pg_catalog.=) ANY($3::pg_catalog.int8[])
  ORDER BY queryid
  LIMIT $4
)
SELECT epoch.postmaster_start, epoch.stats_reset, candidates.*
FROM epoch LEFT JOIN candidates ON true
ORDER BY candidates.queryid NULLS LAST`;

function limits(input: QueryStatisticsCollectOptions["_limits"]): QueryStatisticsLimits {
  const shorten = (value: number | undefined, maximum: number): number =>
    Number.isSafeInteger(value) && value! >= 0 ? Math.min(value!, maximum) : maximum;
  return {
    maxOperations: shorten(input?.maxOperations, MAX_OPERATIONS),
    maxMappingProbes: shorten(input?.maxMappingProbes, MAX_MAPPING_PROBES),
    maxCandidateRows: shorten(input?.maxCandidateRows, MAX_CANDIDATE_ROWS),
    maxComparisonEntries: shorten(input?.maxComparisonEntries, MAX_COMPARISON_ENTRIES),
  };
}

export function createQueryStatisticsFamily(
  status: QueryStatisticsStatus,
  observedAt = Date.now(),
): QueryStatisticsFamily {
  return { status, observedAt, scope: "aggregate" };
}

function failureStatus(error: unknown, signal?: AbortSignal): FailureStatus {
  if (signal?.aborted) return "timeout";
  if (error instanceof PostgreSqlStorageOperationError) {
    if (error.sqlState === "57014") return "timeout";
    if (["42501", "28000", "28P01"].includes(error.sqlState ?? "")) {
      return "permission-denied";
    }
  }
  return "unavailable";
}

function noCommit(family: QueryStatisticsFamily): QueryStatisticsObservation {
  return { family, commit: () => false };
}

function unsignedInteger(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) return null;
  return BigInt(value);
}

function safeCounter(value: unknown): number | null {
  const parsed = unsignedInteger(value);
  return parsed !== null && parsed <= MAX_SAFE_COUNTER ? Number(parsed) : null;
}

function positiveSafeCounter(value: unknown): number | null {
  const parsed = safeCounter(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function nonnegativeFloat(value: unknown): number | null {
  const parsed = typeof value === "number" ? value
    : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function timestamp(value: unknown): string | null {
  return typeof value === "string" && SERVER_TIMESTAMP.test(value) ? value : null;
}

function oid(value: unknown): string | null {
  const parsed = unsignedInteger(value);
  return parsed !== null && parsed > 0n && parsed <= 4_294_967_295n
    ? parsed.toString() : null;
}

function stringSetting(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseJsonString(source: string, start: number): { value: string; end: number } {
  let index = start + 1;
  for (; index < source.length; index += 1) {
    if (source[index] === "\\") { index += 1; continue; }
    if (source[index] === '"') {
      const token = source.slice(start, index + 1);
      return { value: JSON.parse(token) as string, end: index + 1 };
    }
  }
  throw new Error("malformed plan");
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (/\s/u.test(source[index] ?? "")) index += 1;
  return index;
}

function parsePlanIdentifier(source: string): string | null {
  if (Buffer.byteLength(source, "utf8") > MAX_PLAN_BYTES) throw new Error("oversize plan");
  let index = skipWhitespace(source, 0);
  if (source[index++] !== "[") throw new Error("malformed plan");
  index = skipWhitespace(source, index);
  if (source[index++] !== "{") throw new Error("malformed plan");
  let identifier: string | null = null;
  let depth = 1;
  let expectKey = true;
  while (index < source.length && depth > 0) {
    index = skipWhitespace(source, index);
    const character = source[index];
    if (character === '"') {
      const parsed = parseJsonString(source, index);
      index = skipWhitespace(source, parsed.end);
      if (depth === 1 && expectKey && source[index] === ":") {
        index = skipWhitespace(source, index + 1);
        if (parsed.value === "Query Identifier") {
          if (identifier !== null) throw new Error("duplicate identifier");
          const match = /^-?[0-9]+/u.exec(source.slice(index));
          if (!match) throw new Error("malformed identifier");
          const value = BigInt(match[0]);
          if (value < MIN_QUERY_ID || value > MAX_QUERY_ID) throw new Error("identifier range");
          identifier = value.toString();
          index += match[0].length;
          const delimiter = source[skipWhitespace(source, index)];
          if (delimiter !== "," && delimiter !== "}") throw new Error("malformed identifier");
          expectKey = false;
          continue;
        }
      }
      expectKey = false;
      continue;
    }
    if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") depth -= 1;
    else if (character === "," && depth === 1) expectKey = true;
    index += 1;
  }
  if (depth !== 0) throw new Error("malformed plan");
  index = skipWhitespace(source, index);
  if (source[index++] !== "]" || skipWhitespace(source, index) !== source.length) {
    throw new Error("malformed plan");
  }
  return identifier;
}

function allOmitted(reason: QueryStatisticOmission): Record<QueryStatisticMetric, QueryStatisticOmission> {
  return Object.fromEntries(QUERY_STATISTIC_METRICS.map((metric) => [metric, reason])) as
    Record<QueryStatisticMetric, QueryStatisticOmission>;
}

function rawPlanTypes(): NonNullable<QueryConfig["types"]> {
  return { getTypeParser: (() => (value: string) => value) as NonNullable<QueryConfig["types"]>["getTypeParser"] };
}

function operationFailureRank(status: FailureStatus): number {
  return status === "permission-denied" ? 3 : status === "timeout" ? 2 : 1;
}

function comparisonKey(
  witness: string,
  roleOid: string,
  databaseOid: string,
  mappings: ReadonlyMap<string, readonly string[]>,
): string {
  return JSON.stringify([witness, roleOid, databaseOid,
    [...mappings].map(([operation, ids]) => [operation, [...ids].sort()])]);
}

function counterMap(
  row: StatisticRow,
  planning: "on" | "off" | "unknown",
  ioTiming: "on" | "off" | "unknown",
): Record<string, StoredCounter> {
  const counters: Record<string, StoredCounter> = {};
  for (const source of MONOTONIC_SOURCES) {
    if (source === "total_plan_time" && planning !== "on") continue;
    if ((source === "shared_blk_read_time" || source === "shared_blk_write_time")
        && ioTiming !== "on") continue;
    const value = Object.values(INTEGER_SOURCES).includes(source as never)
      ? unsignedInteger(row[source]) : nonnegativeFloat(row[source]);
    if (value !== null) counters[source] = value;
  }
  return counters;
}

function decreased(current: StoredCounter, previous: StoredCounter): boolean {
  return typeof current === typeof previous && current < previous;
}

interface AggregateResult {
  readonly operation: QueryStatisticOperation;
  readonly entries: readonly StoredEntry[];
  readonly partial: boolean;
}

function aggregateOperation(
  operation: string,
  identifiers: readonly string[],
  rows: ReadonlyMap<string, StatisticRow>,
  prior: ComparisonContext | null,
  planning: "on" | "off" | "unknown",
  ioTiming: "on" | "off" | "unknown",
  forcedReason?: QueryStatisticOmission,
): AggregateResult {
  if (forcedReason !== undefined) {
    return { operation: { operation, values: {}, omitted: allOmitted(forcedReason) }, entries: [], partial: true };
  }
  const contributors = identifiers.map((id) => rows.get(id)).filter((row): row is StatisticRow => row !== undefined);
  if (contributors.length === 0) {
    return { operation: { operation, values: {}, omitted: allOmitted("no-entry") }, entries: [], partial: false };
  }
  const values: Partial<Record<QueryStatisticMetric, number>> = {};
  const omitted: Partial<Record<QueryStatisticMetric, QueryStatisticOmission>> = {};
  let partial = false;
  for (const [metric, source] of Object.entries(INTEGER_SOURCES) as [keyof typeof INTEGER_SOURCES, string][]) {
    let total = 0n;
    let valid = true;
    for (const row of contributors) {
      const value = unsignedInteger(row[source]);
      if (value === null) { valid = false; break; }
      total += value;
    }
    if (!valid || total > MAX_SAFE_COUNTER) { omitted[metric] = "out-of-range"; partial = true; }
    else values[metric] = Number(total);
  }
  for (const [metric, source] of Object.entries(FLOAT_SOURCES) as [keyof typeof FLOAT_SOURCES, string][]) {
    const disabled = metric === "queryPlanTimeTotalMs" && planning === "off"
      || (metric === "querySharedBlkReadTimeMs" || metric === "querySharedBlkWriteTimeMs") && ioTiming === "off";
    const unknown = metric === "queryPlanTimeTotalMs" && planning === "unknown"
      || (metric === "querySharedBlkReadTimeMs" || metric === "querySharedBlkWriteTimeMs") && ioTiming === "unknown";
    if (disabled) { omitted[metric] = "disabled-setting"; continue; }
    if (unknown) { omitted[metric] = "unavailable"; partial = true; continue; }
    let total = 0;
    let valid = true;
    for (const row of contributors) {
      const value = nonnegativeFloat(row[source]);
      if (value === null) { valid = false; break; }
      total += value;
    }
    if (!valid || !Number.isFinite(total) || total < 0) { omitted[metric] = "out-of-range"; partial = true; }
    else values[metric] = total;
  }

  const calls = contributors.map((row) => unsignedInteger(row.calls));
  const totalCalls = calls.every((value): value is bigint => value !== null)
    ? calls.reduce((sum, value) => sum + value, 0n) : null;
  const totalExec = contributors.map((row) => nonnegativeFloat(row.total_exec_time));
  const means = contributors.map((row) => nonnegativeFloat(row.mean_exec_time));
  const deviations = contributors.map((row) => nonnegativeFloat(row.stddev_exec_time));
  if (totalCalls === null || totalCalls === 0n || totalCalls > MAX_SAFE_COUNTER
      || totalExec.some((value) => value === null)) {
    omitted.queryExecTimeMeanMs = totalCalls === 0n ? "no-baseline" : "out-of-range";
    omitted.queryExecTimeStddevMs = totalCalls === 0n ? "no-baseline" : "out-of-range";
    if (totalCalls !== 0n) partial = true;
  } else {
    const mean = totalExec.reduce<number>((sum, value) => sum + value!, 0) / Number(totalCalls);
    const variance = contributors.reduce((sum, _row, index) => {
      const count = Number(calls[index]!);
      const entryMean = means[index];
      const deviation = deviations[index];
      return entryMean === null || deviation === null ? Number.NaN
        : sum + count * (deviation ** 2 + (entryMean - mean) ** 2);
    }, 0) / Number(totalCalls);
    if (!Number.isFinite(mean)) { omitted.queryExecTimeMeanMs = "out-of-range"; partial = true; }
    else values.queryExecTimeMeanMs = mean;
    if (!Number.isFinite(variance)) { omitted.queryExecTimeStddevMs = "out-of-range"; partial = true; }
    else values.queryExecTimeStddevMs = Math.sqrt(variance);
  }

  const entries: StoredEntry[] = [];
  const extrema: { min: number; max: number }[] = [];
  let extremaInitialized = true;
  let extremaOutOfRange = false;
  for (let index = 0; index < contributors.length; index += 1) {
    const row = contributors[index]!;
    const id = String(row.queryid);
    const statsSince = timestamp(row.stats_since)!;
    const minmaxStatsSince = timestamp(row.minmax_stats_since)!;
    const previous = prior?.entries.get(id);
    const callCount = calls[index];
    const initialized = callCount !== null && callCount > 0n && (
      statsSince === minmaxStatsSince
      || previous !== undefined && !previous.absent
        && previous.statsSince === statsSince
        && previous.minmaxStatsSince === minmaxStatsSince
        && (previous.initialized || (
          typeof previous.counters.calls === "bigint"
          && callCount > previous.counters.calls
        ))
    );
    entries.push({ operation, queryid: id, statsSince, minmaxStatsSince,
      initialized, absent: false, counters: counterMap(row, planning, ioTiming) });
    if (callCount !== null && callCount > 0n) {
      const min = nonnegativeFloat(row.min_exec_time);
      const max = nonnegativeFloat(row.max_exec_time);
      if (min === null || max === null) extremaOutOfRange = true;
      else if (!initialized) extremaInitialized = false;
      else extrema.push({ min, max });
    }
  }
  if (extremaOutOfRange) {
    omitted.queryExecTimeMinMs = "out-of-range";
    omitted.queryExecTimeMaxMs = "out-of-range";
    partial = true;
  } else if (!extremaInitialized || extrema.length === 0) {
    omitted.queryExecTimeMinMs = "no-baseline";
    omitted.queryExecTimeMaxMs = "no-baseline";
  } else {
    values.queryExecTimeMinMs = Math.min(...extrema.map((value) => value.min));
    values.queryExecTimeMaxMs = Math.max(...extrema.map((value) => value.max));
  }
  return { operation: { operation, values, omitted }, entries, partial };
}

export function createPostgreSqlQueryStatisticsCollector() {
  let context: ComparisonContext | null = null;
  let sequence = 0;

  return {
    async collect(
      executor: PostgreSqlQueryExecutor,
      options: QueryStatisticsCollectOptions,
    ): Promise<QueryStatisticsObservation> {
      const now = (): number => options.observedAt ?? Date.now();
      const startSequence = sequence;
      const cap = limits(options._limits);
      if (options.signal?.aborted) return noCommit(createQueryStatisticsFamily("timeout", now()));

      let contextRow: ContextRow;
      try {
        const result = await executor.query<ContextRow>({ text: CONTEXT_SQL }, {
          domain: "factory", operation: "queryStatisticsContext", signal: options.signal,
        });
        if (result.rows.length !== 1) throw new Error("context shape");
        contextRow = result.rows[0]!;
      } catch (error) {
        return noCommit(createQueryStatisticsFamily(failureStatus(error, options.signal), now()));
      }
      const track = stringSetting(contextRow.track);
      if (track === "none") return noCommit(createQueryStatisticsFamily("disabled", now()));
      if (track !== "top" && track !== "all") return noCommit(createQueryStatisticsFamily("unavailable", now()));
      const roleOid = oid(contextRow.role_oid);
      const databaseOid = oid(contextRow.database_oid);
      const postmasterStart = timestamp(contextRow.postmaster_start);
      if (roleOid === null || databaseOid === null || postmasterStart === null) {
        return noCommit(createQueryStatisticsFamily("unavailable", now()));
      }
      const statsReset = contextRow.stats_reset === null ? null : timestamp(contextRow.stats_reset);
      if (contextRow.stats_reset !== null && statsReset === null) {
        return noCommit(createQueryStatisticsFamily("unavailable", now()));
      }
      const planning = contextRow.track_planning === "on" ? "on"
        : contextRow.track_planning === "off" ? "off" : "unknown";
      const ioTiming = contextRow.track_io_timing === "on" ? "on"
        : contextRow.track_io_timing === "off" ? "off" : "unknown";
      const familyOmitted: NonNullable<QueryStatisticsFamily["omitted"]> = {};
      const blockSize = positiveSafeCounter(contextRow.block_size);
      const dealloc = safeCounter(contextRow.dealloc);
      if (blockSize === null) familyOmitted.blockSize = "out-of-range";
      if (dealloc === null) familyOmitted.statementsDeallocTotal = "out-of-range";
      if (statsReset === null) familyOmitted.statementsStatsReset = "no-baseline";

      const catalog = QUERY_OPERATION_CATALOG.slice(0, cap.maxOperations);
      const operationIds = new Map<string, string[]>();
      const operationFailures = new Map<string, FailureStatus>();
      const successfulWithoutIdentifier = new Set<string>();
      let probeCount = 0;
      for (const operation of catalog) {
        for (const template of operation.templates) {
          if (probeCount >= cap.maxMappingProbes) {
            if (!operationFailures.has(operation.id)) {
              operationFailures.set(operation.id, "unavailable");
            }
            continue;
          }
          probeCount += 1;
          try {
            const result = await executor.query<{ "QUERY PLAN": unknown }>({
              text: `EXPLAIN (GENERIC_PLAN, VERBOSE, FORMAT JSON) ${template}`,
              types: rawPlanTypes(),
            }, { domain: "factory", operation: "queryStatisticsMapping", signal: options.signal });
            const raw = result.rows.length === 1 ? result.rows[0]?.["QUERY PLAN"] : undefined;
            if (typeof raw !== "string") throw new Error("plan shape");
            const identifier = parsePlanIdentifier(raw);
            if (identifier === null) successfulWithoutIdentifier.add(operation.id);
            else operationIds.set(operation.id, [...new Set([...(operationIds.get(operation.id) ?? []), identifier])]);
          } catch (error) {
            const status = failureStatus(error, options.signal);
            const current = operationFailures.get(operation.id);
            if (current === undefined || operationFailureRank(status) > operationFailureRank(current)) {
              operationFailures.set(operation.id, status);
            }
          }
        }
      }
      for (const operation of QUERY_OPERATION_CATALOG.slice(catalog.length)) {
        operationFailures.set(operation.id, "unavailable");
      }

      const identifierOwners = new Map<string, string[]>();
      for (const [operation, identifiers] of operationIds) {
        for (const identifier of identifiers) {
          identifierOwners.set(identifier, [...(identifierOwners.get(identifier) ?? []), operation]);
        }
      }
      const collided = new Set<string>();
      for (const owners of identifierOwners.values()) {
        if (owners.length > 1) for (const owner of owners) collided.add(owner);
      }
      for (const operation of collided) operationIds.delete(operation);
      const identifiers = [...new Set([...operationIds.values()].flat())];
      if (identifiers.length === 0) {
        if (successfulWithoutIdentifier.size > 0 || collided.size > 0) {
          return noCommit(createQueryStatisticsFamily("unavailable", now()));
        }
        const failures = [...operationFailures.values()];
        const status = failures.sort((a, b) => operationFailureRank(b) - operationFailureRank(a))[0]!;
        return noCommit(createQueryStatisticsFamily(status, now()));
      }

      const key = comparisonKey(options.publicationWitness, roleOid, databaseOid, operationIds);
      const prior = context?.key === key ? context : null;
      let resultRows: StatisticRow[];
      try {
        const result = await executor.query<StatisticRow>({
          text: ROWS_SQL,
          values: [roleOid, databaseOid, identifiers, cap.maxCandidateRows + 1],
        }, { domain: "factory", operation: "queryStatisticsRows", signal: options.signal });
        resultRows = result.rows;
      } catch (error) {
        return noCommit(createQueryStatisticsFamily(failureStatus(error, options.signal), now()));
      }
      if (resultRows.length === 0) return noCommit(createQueryStatisticsFamily("unavailable", now()));
      const sentinel = resultRows.length === 1 && resultRows[0]?.queryid === null;
      if (resultRows.some((row) => row.queryid === null) && !sentinel) {
        return noCommit(createQueryStatisticsFamily("unavailable", now()));
      }
      const epochs = resultRows.map((row) => {
        const rowPostmasterStart = timestamp(row.postmaster_start);
        const rowStatsReset = row.stats_reset === null ? null : timestamp(row.stats_reset);
        if (rowPostmasterStart === null || (row.stats_reset !== null && rowStatsReset === null)) {
          return null;
        }
        return { postmasterStart: rowPostmasterStart, statsReset: rowStatsReset };
      });
      if (epochs.some((epoch) => epoch === null)) {
        return noCommit(createQueryStatisticsFamily("unavailable", now()));
      }
      const firstEpoch = epochs[0]!;
      if (epochs.some((epoch) => epoch!.postmasterStart !== firstEpoch.postmasterStart
          || epoch!.statsReset !== firstEpoch.statsReset)) {
        return noCommit(createQueryStatisticsFamily("unavailable", now()));
      }
      if (firstEpoch.postmasterStart !== postmasterStart || firstEpoch.statsReset !== statsReset) {
        return noCommit(createQueryStatisticsFamily("stale", now()));
      }
      const candidates = sentinel ? [] : resultRows.slice(0, cap.maxCandidateRows);
      const truncated = !sentinel && resultRows.length > cap.maxCandidateRows;
      const rows = new Map<string, StatisticRow>();
      for (const row of candidates) {
        const parsedId = typeof row.queryid === "string" && /^-?[0-9]+$/u.test(row.queryid)
          ? BigInt(row.queryid) : null;
        const id = parsedId !== null && parsedId >= MIN_QUERY_ID && parsedId <= MAX_QUERY_ID
          ? parsedId.toString() : null;
        if (id === null || !identifiers.includes(id) || rows.has(id)
            || timestamp(row.stats_since) === null || timestamp(row.minmax_stats_since) === null) {
          return noCommit(createQueryStatisticsFamily("unavailable", now()));
        }
        rows.set(id, row);
      }

      let resetFact = prior !== null && (
        prior.postmasterStart !== postmasterStart || prior.statsReset !== statsReset
      );
      let comparisonPartial = false;
      const aggregateResults: AggregateResult[] = [];
      const mappingIncomplete = catalog.length !== QUERY_OPERATION_CATALOG.length
        || probeCount !== QUERY_OPERATION_CATALOG.flatMap((operation) => operation.templates).length
        || operationFailures.size > 0 || successfulWithoutIdentifier.size > 0 || collided.size > 0;
      let structuralPartial = mappingIncomplete || truncated
        || blockSize === null || dealloc === null || planning === "unknown" || ioTiming === "unknown";
      for (const operation of QUERY_OPERATION_CATALOG) {
        const ids = operationIds.get(operation.id) ?? [];
        let forcedReason: QueryStatisticOmission | undefined;
        const failure = operationFailures.get(operation.id);
        if (failure !== undefined) forcedReason = failure;
        else if (successfulWithoutIdentifier.has(operation.id) || collided.has(operation.id)) forcedReason = "unavailable";
        else if (truncated && ids.some((id) => !rows.has(id))) forcedReason = "unavailable";
        const aggregate = aggregateOperation(
          operation.id, ids, rows, prior, planning, ioTiming, forcedReason,
        );
        structuralPartial ||= aggregate.partial;
        aggregateResults.push(aggregate);
      }

      const currentEntries = new Map<string, StoredEntry>();
      for (const aggregate of aggregateResults) {
        for (const entry of aggregate.entries) currentEntries.set(entry.queryid, entry);
      }
      if (prior !== null) {
        for (const [id, previous] of prior.entries) {
          const current = currentEntries.get(id);
          if (current === undefined) {
            if (!previous.absent) comparisonPartial = true;
            currentEntries.set(id, { ...previous, absent: true, counters: {} });
            continue;
          }
          if (previous.statsSince !== current.statsSince) resetFact = true;
          else if (!previous.absent) {
            for (const [source, value] of Object.entries(current.counters)) {
              const old = previous.counters[source];
              if (old !== undefined && decreased(value, old)) comparisonPartial = true;
            }
          }
        }
      }
      if (currentEntries.size > cap.maxComparisonEntries) structuralPartial = true;

      const status: QueryStatisticsStatus = resetFact ? "reset"
        : structuralPartial || comparisonPartial ? "partial" : "observed";
      const family: QueryStatisticsFamily = {
        status, observedAt: now(), scope: "aggregate",
        ...(dealloc === null ? {} : { statementsDeallocTotal: dealloc }),
        ...(statsReset === null ? {} : { statementsStatsReset: statsReset }),
        ...(blockSize === null ? {} : { blockSize }),
        ...(Object.keys(familyOmitted).length === 0 ? {} : { omitted: familyOmitted }),
        operations: aggregateResults.map((result) => result.operation),
      };
      const canStore = !mappingIncomplete && !truncated
        && currentEntries.size <= cap.maxComparisonEntries
        && (status === "observed" || status === "reset"
          || status === "partial" && !structuralPartial);
      const nextContext: ComparisonContext = {
        key, postmasterStart, statsReset, entries: currentEntries,
      };
      let committed = false;
      return {
        family,
        commit: () => {
          if (committed || !canStore || sequence !== startSequence) return false;
          committed = true;
          context = nextContext;
          sequence += 1;
          return true;
        },
      };
    },
  };
}

const defaultCollector = createPostgreSqlQueryStatisticsCollector();

export function collectPostgreSqlQueryStatistics(
  executor: PostgreSqlQueryExecutor,
  options: QueryStatisticsCollectOptions,
): Promise<QueryStatisticsObservation> {
  return defaultCollector.collect(executor, options);
}
