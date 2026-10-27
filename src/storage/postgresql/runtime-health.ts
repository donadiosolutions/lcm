import { normalizeUuidV7 } from "../../machine-identity.js";
import { StorageOperationError } from "../errors.js";
import { QUEUE_CANDIDATE_LIMIT, type MigrationLedgerRead, type ServerQueueRead } from "../runtime-health.js";
import type { PostgreSqlQueryExecutor } from "./contracts.js";
import { loadPostgreSqlMigrations } from "./migrations.js";

function invalidRead(operation: string): never {
  throw new StorageOperationError("STORAGE_OPERATION_FAILED", "postgresql", undefined, "factory", operation);
}

/**
 * Reads at most one more ledger row than the packaged history has. The read
 * is projectless and the packaged list is verified in process. The caller
 * interprets the rows, and IDs and checksums never reach the snapshot.
 */
export async function readPostgreSqlMigrationLedger(
  executor: PostgreSqlQueryExecutor,
  signal?: AbortSignal,
  loadMigrations: typeof loadPostgreSqlMigrations = loadPostgreSqlMigrations,
): Promise<MigrationLedgerRead> {
  if (signal?.aborted) return invalidRead("diagnosticMigrationHistory");
  const expected = loadMigrations().map(migration => ({ id: migration.id, sha256: migration.sha256 }));
  const result = await executor.query<{ id: unknown; checksum_sha256: unknown }>({
    text: "SELECT id, checksum_sha256 FROM lcm.schema_migrations ORDER BY id LIMIT $1::pg_catalog.int4",
    values: [expected.length + 1],
  }, { domain: "factory", operation: "diagnosticMigrationHistory", signal });
  if (signal?.aborted) return invalidRead("diagnosticMigrationHistory");
  return { expected, rows: result.rows };
}

type QueueRow = {
  candidate_count: unknown; claimed: unknown; quarantined: unknown; replay_lag_seconds: unknown;
};

/**
 * Bounded inbox aggregate. The candidate rows (one extra as a cap sentinel) are
 * materialized before aggregation, and the server clock is read once so the
 * due filter and the lag share one instant. Scope is a bound parameter; the
 * query options carry no project metadata, which would enter the runtime's
 * writer admission transaction.
 */
export async function readPostgreSqlQueueHealth(
  executor: PostgreSqlQueryExecutor,
  signal?: AbortSignal,
  projectId?: string,
): Promise<ServerQueueRead> {
  if (signal?.aborted) return invalidRead("diagnosticQueue");
  const selected = projectId === undefined ? undefined : normalizeUuidV7(projectId);
  if (selected === null) return invalidRead("diagnosticQueue");
  const scoped = selected === undefined ? "" : "AND project_id OPERATOR(pg_catalog.=) $2::pg_catalog.uuid";
  const result = await executor.query<QueueRow>({
    text: `WITH clock AS MATERIALIZED (
             SELECT pg_catalog.clock_timestamp() AS now
           ), candidates AS MATERIALIZED (
             SELECT status, next_attempt_at FROM lcm.passive_event_inbox
             WHERE status IN ('pending', 'retry', 'claimed', 'quarantined') ${scoped}
             ORDER BY inbox_id LIMIT $1::pg_catalog.int4
           )
           SELECT pg_catalog.count(*)::pg_catalog.text AS candidate_count,
                  (pg_catalog.count(*) FILTER (WHERE status = 'claimed'))::pg_catalog.text AS claimed,
                  (pg_catalog.count(*) FILTER (WHERE status = 'quarantined'))::pg_catalog.text AS quarantined,
                  EXTRACT(EPOCH FROM (
                    (SELECT now FROM clock) - pg_catalog.min(next_attempt_at)
                      FILTER (WHERE status IN ('pending', 'retry') AND next_attempt_at <= (SELECT now FROM clock))
                  ))::pg_catalog.text AS replay_lag_seconds
           FROM candidates`,
    values: selected === undefined ? [QUEUE_CANDIDATE_LIMIT + 1] : [QUEUE_CANDIDATE_LIMIT + 1, selected],
  }, { domain: "factory", operation: "diagnosticQueue", signal });
  if (signal?.aborted) return invalidRead("diagnosticQueue");
  const row = result.rows[0];
  const candidates = typeof row?.candidate_count === "string" && /^[0-9]+$/u.test(row.candidate_count)
    ? Number(row.candidate_count) : undefined;
  if (result.rows.length !== 1 || candidates === undefined) return invalidRead("diagnosticQueue");
  return { capReached: candidates > QUEUE_CANDIDATE_LIMIT, claimed: row.claimed, quarantined: row.quarantined, lagSeconds: row.replay_lag_seconds };
}
