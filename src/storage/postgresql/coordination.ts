import { createHash } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";
import type { JsonObject } from "../contracts.js";
import { StorageOperationError } from "../errors.js";
import type {
  PostgreSqlOperationContext,
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
  PostgreSqlTransactionScopeExecutor,
} from "./contracts.js";
import { PostgreSqlStorageOperationError } from "./errors.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UUIDV7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LOCK_NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/u;
const DECIMAL_BIGINT_PATTERN = /^-?\d+$/u;

type CoordinationContext = PostgreSqlOperationContext & {
  readonly domain: "coordination";
  readonly projectId: string;
  readonly machineId: string;
  readonly signal?: AbortSignal;
};

export interface PostgreSqlCoordinationExecutor
extends PostgreSqlQueryExecutor {
  transaction<T>(
    callback: (transaction: PostgreSqlTransactionScopeExecutor) => Promise<T>,
    options: CoordinationContext,
  ): Promise<T>;
}

export type PostgreSqlCoordinationRepositoryExecutor =
  | PostgreSqlCoordinationExecutor
  | PostgreSqlTransactionScopeExecutor;

export interface PostgreSqlCoordinationOwner {
  readonly machineId: string;
  readonly processId: string;
  readonly operation: string;
}

export interface PostgreSqlCoordinationResource {
  readonly resourceType: string;
  readonly resourceKey: string;
}

export interface PostgreSqlTransactionLockInput
extends PostgreSqlCoordinationResource {
  readonly operation: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface PostgreSqlTransactionLock
extends PostgreSqlCoordinationResource {
  readonly projectId: string;
  readonly machineId: string;
  readonly operation: string;
  readonly lockName: string;
}

export interface PostgreSqlAcquireLeaseInput
extends PostgreSqlCoordinationResource {
  readonly processId: string;
  readonly operation: string;
  readonly ttlMs: number;
  readonly signal?: AbortSignal;
}

export interface PostgreSqlLeaseMutationInput
extends PostgreSqlCoordinationResource {
  readonly processId: string;
  readonly operation: string;
  readonly fencingToken: bigint;
  readonly signal?: AbortSignal;
}

export interface PostgreSqlRenewLeaseInput
extends PostgreSqlLeaseMutationInput {
  readonly ttlMs: number;
}

export interface PostgreSqlFencedLease
extends PostgreSqlCoordinationResource, PostgreSqlCoordinationOwner {
  readonly projectId: string;
  readonly fencingToken: bigint;
  readonly acquiredAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
  readonly releasedAt: string | null;
}

export interface PostgreSqlLeaseDiagnostic extends PostgreSqlFencedLease {
  readonly state: "active" | "expired" | "released";
}

export interface PostgreSqlLeaseFenceValidation
extends PostgreSqlCoordinationResource, PostgreSqlCoordinationOwner {
  readonly projectId: string;
  readonly fencingToken: bigint;
  readonly validatedAt: string;
}

export interface PostgreSqlClaimPassiveEventsInput {
  readonly claimOwner: string;
  readonly limit: number;
  readonly staleClaimMs: number;
  readonly signal?: AbortSignal;
}

export interface PostgreSqlPassiveEventClaim {
  readonly inboxId: bigint;
  readonly projectId: string;
  readonly machineId: string;
  readonly eventId: string;
  readonly eventVersion: number;
  readonly machineSequence: bigint;
  readonly eventType: string;
  readonly payload: JsonObject;
  readonly attemptCount: number;
  readonly receivedAt: string;
  readonly nextAttemptAt: string;
  readonly claimedAt: string;
  readonly claimedBy: string;
}

export interface PostgreSqlLeaseCleanupInput {
  readonly retentionMs: number;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export interface PostgreSqlLeaseCleanup {
  readonly projectId: string;
  readonly deletedCount: bigint;
}

export interface PostgreSqlCoordinationDiagnostics {
  readonly leases: {
    readonly active: bigint;
    readonly expired: bigint;
    readonly released: bigint;
    readonly oldestActiveExpiryAt: string | null;
  };
  readonly queue: {
    readonly pending: bigint;
    readonly claimed: bigint;
    readonly retry: bigint;
    readonly applied: bigint;
    readonly quarantined: bigint;
    readonly oldestReadyAt: string | null;
    readonly oldestClaimedAt: string | null;
  };
}

type LeaseRow = QueryResultRow & {
  project_id: unknown;
  resource_type: unknown;
  resource_key: unknown;
  owner_machine_id: unknown;
  owner_process_id: unknown;
  operation: unknown;
  fencing_token: unknown;
  acquired_at: unknown;
  renewed_at: unknown;
  expires_at: unknown;
  released_at: unknown;
};

type LeaseDiagnosticRow = LeaseRow & { state: unknown };

type PassiveEventClaimRow = QueryResultRow & {
  inbox_id: unknown;
  project_id: unknown;
  machine_id: unknown;
  event_id: unknown;
  event_version: unknown;
  machine_sequence: unknown;
  event_type: unknown;
  payload: unknown;
  attempt_count: unknown;
  received_at: unknown;
  next_attempt_at: unknown;
  claimed_at: unknown;
  claimed_by: unknown;
};

type CountRow = QueryResultRow & { count: unknown };
type IsolationRow = QueryResultRow & { transaction_isolation: unknown };
type SettingRow = QueryResultRow & { setting: unknown };
type DiagnosticsRow = QueryResultRow & {
  active_leases: unknown;
  expired_leases: unknown;
  released_leases: unknown;
  oldest_active_expiry_at: unknown;
  pending_events: unknown;
  claimed_events: unknown;
  retry_events: unknown;
  applied_events: unknown;
  quarantined_events: unknown;
  oldest_ready_at: unknown;
  oldest_claimed_at: unknown;
};

export class PostgreSqlCoordinationDataError extends StorageOperationError {
  constructor(
    projectId: string,
    operation: string,
    readonly field: string,
    readonly machineId?: string,
  ) {
    super(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      projectId,
      "coordination",
      operation,
    );
    this.name = "PostgreSqlCoordinationDataError";
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      field: this.field,
      ...(this.machineId === undefined ? {} : { machineId: this.machineId }),
    };
  }
}

export class PostgreSqlLeaseFenceError extends StorageOperationError {
  constructor(
    projectId: string,
    readonly machineId: string,
    readonly fencingToken: bigint,
    operation: string,
  ) {
    super(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      projectId,
      "coordination",
      operation,
    );
    this.name = "PostgreSqlLeaseFenceError";
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      machineId: this.machineId,
      fencingToken: this.fencingToken.toString(),
    };
  }
}

export class PostgreSqlCoordinationOperationError extends StorageOperationError {
  constructor(
    projectId: string,
    readonly machineId: string,
    operation: string,
    retryable: boolean,
  ) {
    super(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      projectId,
      "coordination",
      operation,
      { retryable },
    );
    this.name = "PostgreSqlCoordinationOperationError";
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      machineId: this.machineId,
    };
  }
}

/**
 * Derive the exact project-scoped text passed to PostgreSQL's
 * hashtextextended(..., 0) advisory-lock namespace.
 *
 * The optional resource key is SHA-256 digested before concatenation so
 * arbitrary caller text cannot collide through delimiter placement. The
 * existing conversation and session-ingest call sites use this same format,
 * which also matches their schema triggers.
 */
export function derivePostgreSqlAdvisoryLockName(
  projectId: string,
  namespace: string,
  resourceKey?: string,
): string {
  const canonicalProjectId = projectId.toLowerCase();
  return resourceKey === undefined
    ? `${canonicalProjectId}:${namespace}`
    : `${canonicalProjectId}:${namespace}:${
        createHash("sha256").update(resourceKey, "utf8").digest("hex")
      }`;
}

function coordinationError(
  projectId: string,
  operation: string,
  field: string,
  machineId?: string,
): never {
  throw new PostgreSqlCoordinationDataError(
    projectId,
    operation,
    field,
    machineId,
  );
}

function isRetryableTransactionLockFailure(error: unknown): boolean {
  if (!(error instanceof StorageOperationError)) return false;
  if (error.retryable) return true;
  // 55P03 is context-dependent. Only a bounded coordination lock_timeout
  // makes lock unavailability safe for callers to retry.
  return error instanceof PostgreSqlStorageOperationError
    && error.sqlState === "55P03";
}

function text(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
  machineId?: string,
): string {
  if (typeof value !== "string") {
    return coordinationError(projectId, operation, field, machineId);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) {
      return coordinationError(projectId, operation, field, machineId);
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) {
        return coordinationError(projectId, operation, field, machineId);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return coordinationError(projectId, operation, field, machineId);
    }
  }
  return value;
}

function nonblankText(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
  machineId?: string,
): string {
  const candidate = text(value, projectId, operation, field, machineId);
  return candidate.trim().length === 0
    ? coordinationError(projectId, operation, field, machineId)
    : candidate;
}

function uuid(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
  machineId?: string,
): string {
  const candidate = text(
    value,
    projectId,
    operation,
    field,
    machineId,
  );
  return UUID_PATTERN.test(candidate)
    ? candidate.toLowerCase()
    : coordinationError(projectId, operation, field, machineId);
}

function uuidV7(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
  machineId?: string,
): string {
  const candidate = uuid(
    value,
    projectId,
    operation,
    field,
    machineId,
  );
  return UUIDV7_PATTERN.test(candidate)
    ? candidate
    : coordinationError(projectId, operation, field, machineId);
}

function positiveSafeInteger(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
  machineId?: string,
): number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    ? value
    : coordinationError(projectId, operation, field, machineId);
}

function safeInteger(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
  machineId?: string,
): number {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : coordinationError(projectId, operation, field, machineId);
}

function exactBigInt(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
  minimum: bigint,
  machineId?: string,
): bigint {
  if (
    typeof value !== "bigint"
    && (typeof value !== "string" || !DECIMAL_BIGINT_PATTERN.test(value))
  ) {
    return coordinationError(projectId, operation, field, machineId);
  }
  const candidate = typeof value === "bigint" ? value : BigInt(value);
  return candidate >= minimum
    ? candidate
    : coordinationError(projectId, operation, field, machineId);
}

function timestamp(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
  machineId?: string,
): string {
  const candidate = value instanceof Date
    ? new Date(value.getTime())
    : typeof value === "string"
      ? new Date(value)
      : new Date(Number.NaN);
  return Number.isFinite(candidate.getTime())
    ? candidate.toISOString()
    : coordinationError(projectId, operation, field, machineId);
}

function nullableTimestamp(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
  machineId?: string,
): string | null {
  return value === null
    ? null
    : timestamp(value, projectId, operation, field, machineId);
}

function jsonObject(
  value: unknown,
  projectId: string,
  operation: string,
  field: string,
  machineId?: string,
): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : coordinationError(projectId, operation, field, machineId);
}

function resource(
  value: PostgreSqlCoordinationResource,
  projectId: string,
  operation: string,
  machineId: string,
): PostgreSqlCoordinationResource {
  return {
    resourceType: nonblankText(
      value.resourceType,
      projectId,
      operation,
      "resource_type",
      machineId,
    ),
    resourceKey: nonblankText(
      value.resourceKey,
      projectId,
      operation,
      "resource_key",
      machineId,
    ),
  };
}

function leaseFromRow(
  row: LeaseRow,
  projectId: string,
  operation: string,
  expectedMachineId?: string,
): PostgreSqlFencedLease {
  const machineId = uuidV7(
    row.owner_machine_id,
    projectId,
    operation,
    "owner_machine_id",
    expectedMachineId,
  );
  return {
    projectId: uuidV7(
      row.project_id,
      projectId,
      operation,
      "project_id",
      machineId,
    ),
    resourceType: nonblankText(
      row.resource_type,
      projectId,
      operation,
      "resource_type",
      machineId,
    ),
    resourceKey: nonblankText(
      row.resource_key,
      projectId,
      operation,
      "resource_key",
      machineId,
    ),
    machineId,
    processId: nonblankText(
      row.owner_process_id,
      projectId,
      operation,
      "owner_process_id",
      machineId,
    ),
    operation: nonblankText(
      row.operation,
      projectId,
      operation,
      "lease_operation",
      machineId,
    ),
    fencingToken: exactBigInt(
      row.fencing_token,
      projectId,
      operation,
      "fencing_token",
      1n,
      machineId,
    ),
    acquiredAt: timestamp(
      row.acquired_at,
      projectId,
      operation,
      "acquired_at",
      machineId,
    ),
    renewedAt: timestamp(
      row.renewed_at,
      projectId,
      operation,
      "renewed_at",
      machineId,
    ),
    expiresAt: timestamp(
      row.expires_at,
      projectId,
      operation,
      "expires_at",
      machineId,
    ),
    releasedAt: nullableTimestamp(
      row.released_at,
      projectId,
      operation,
      "released_at",
      machineId,
    ),
  };
}

function passiveEventClaimFromRow(
  row: PassiveEventClaimRow,
  projectId: string,
  operation: string,
): PostgreSqlPassiveEventClaim {
  const machineId = uuidV7(
    row.machine_id,
    projectId,
    operation,
    "machine_id",
  );
  const eventVersion = safeInteger(
    row.event_version,
    projectId,
    operation,
    "event_version",
    machineId,
  );
  const attemptCount = safeInteger(
    row.attempt_count,
    projectId,
    operation,
    "attempt_count",
    machineId,
  );
  if (eventVersion <= 0) {
    return coordinationError(
      projectId,
      operation,
      "event_version",
      machineId,
    );
  }
  if (attemptCount < 0) {
    return coordinationError(
      projectId,
      operation,
      "attempt_count",
      machineId,
    );
  }
  return {
    inboxId: exactBigInt(
      row.inbox_id,
      projectId,
      operation,
      "inbox_id",
      1n,
      machineId,
    ),
    projectId: uuidV7(
      row.project_id,
      projectId,
      operation,
      "project_id",
      machineId,
    ),
    machineId,
    eventId: uuid(
      row.event_id,
      projectId,
      operation,
      "event_id",
      machineId,
    ),
    eventVersion,
    machineSequence: exactBigInt(
      row.machine_sequence,
      projectId,
      operation,
      "machine_sequence",
      0n,
      machineId,
    ),
    eventType: nonblankText(
      row.event_type,
      projectId,
      operation,
      "event_type",
      machineId,
    ),
    payload: jsonObject(
      row.payload,
      projectId,
      operation,
      "payload",
      machineId,
    ),
    attemptCount,
    receivedAt: timestamp(
      row.received_at,
      projectId,
      operation,
      "received_at",
      machineId,
    ),
    nextAttemptAt: timestamp(
      row.next_attempt_at,
      projectId,
      operation,
      "next_attempt_at",
      machineId,
    ),
    claimedAt: timestamp(
      row.claimed_at,
      projectId,
      operation,
      "claimed_at",
      machineId,
    ),
    claimedBy: nonblankText(
      row.claimed_by,
      projectId,
      operation,
      "claimed_by",
      machineId,
    ),
  };
}

export class PostgreSqlWorkCoordinator {
  readonly projectId: string;
  readonly machineId: string;

  constructor(
    private readonly coordinationExecutor:
      PostgreSqlCoordinationRepositoryExecutor,
    projectId: string,
    machineId: string,
  ) {
    this.projectId = uuidV7(
      projectId,
      projectId,
      "construct",
      "project_id",
    );
    this.machineId = uuidV7(
      machineId,
      this.projectId,
      "construct",
      "machine_id",
    );
  }

  async acquireTransactionLock(
    input: PostgreSqlTransactionLockInput,
  ): Promise<PostgreSqlTransactionLock> {
    const operation = nonblankText(
      input.operation,
      this.projectId,
      "acquireTransactionLock",
      "operation",
      this.machineId,
    );
    const normalizedResource = resource(
      input,
      this.projectId,
      operation,
      this.machineId,
    );
    const timeoutMs = positiveSafeInteger(
      input.timeoutMs,
      this.projectId,
      operation,
      "timeout_ms",
      this.machineId,
    );
    const namespace = nonblankText(
      normalizedResource.resourceType,
      this.projectId,
      operation,
      "resource_type",
      this.machineId,
    );
    if (!LOCK_NAMESPACE_PATTERN.test(namespace)) {
      return coordinationError(
        this.projectId,
        operation,
        "resource_type",
        this.machineId,
      );
    }
    const transaction = await this.transactionScope(operation);
    try {
      await this.assertReadCommitted(transaction, operation, input.signal);
      const prior = await transaction.query<SettingRow>({
        text: `SELECT pg_catalog.current_setting('lock_timeout') AS setting`,
      }, this.queryOptions(operation, input.signal));
      const previousSetting = text(
        prior.rows[0]?.setting,
        this.projectId,
        operation,
        "lock_timeout",
        this.machineId,
      );
      const lockName = derivePostgreSqlAdvisoryLockName(
        this.projectId,
        namespace,
        normalizedResource.resourceKey,
      );
      let acquisitionFailure: { readonly error: unknown } | undefined;
      await transaction.query({
        text: `SELECT pg_catalog.set_config(
                        'lock_timeout',
                        $1::pg_catalog.text,
                        true
                      )`,
        values: [`${timeoutMs}ms`],
      }, this.queryOptions(operation, input.signal));
      try {
        await transaction.savepoint(async (savepoint) => {
          await savepoint.query({
            text: `SELECT pg_catalog.pg_advisory_xact_lock(
                            pg_catalog.hashtextextended(
                              $1::pg_catalog.text,
                              0
                            )
                          )`,
            values: [lockName],
          }, this.queryOptions(operation, input.signal));
        }, this.queryOptions(operation, input.signal));
      } catch (error) {
        acquisitionFailure = { error };
      } finally {
        try {
          await transaction.query({
            text: `SELECT pg_catalog.set_config(
                            'lock_timeout',
                            $1::pg_catalog.text,
                            true
                          )`,
            values: [previousSetting],
          }, this.queryOptions(operation));
        } catch (error) {
          acquisitionFailure ??= { error };
        }
      }
      if (acquisitionFailure !== undefined) {
        throw acquisitionFailure.error;
      }
      return {
        projectId: this.projectId,
        machineId: this.machineId,
        resourceType: normalizedResource.resourceType,
        resourceKey: normalizedResource.resourceKey,
        operation,
        lockName,
      };
    } catch (error) {
      if (error instanceof PostgreSqlCoordinationDataError) throw error;
      throw new PostgreSqlCoordinationOperationError(
        this.projectId,
        this.machineId,
        operation,
        isRetryableTransactionLockFailure(error),
      );
    }
  }

  async acquireLease(
    input: PostgreSqlAcquireLeaseInput,
  ): Promise<PostgreSqlFencedLease | null> {
    const operation = "acquireLease";
    const normalized = this.acquireLeaseInput(input, operation);
    return this.atomic(operation, input.signal, async (executor) => {
      const locked = await this.lockLeaseRow(
        executor,
        normalized,
        operation,
        input.signal,
      );
      const values = [
        this.projectId,
        normalized.resourceType,
        normalized.resourceKey,
        this.machineId,
        normalized.processId,
        normalized.operation,
        normalized.ttlMs,
      ];
      let result: QueryResult<LeaseRow>;
      if (locked) {
        result = await executor.query<LeaseRow>({
          text: `UPDATE lcm.fenced_leases
                 SET owner_machine_id = $4,
                     owner_process_id = $5,
                     operation = $6,
                     fencing_token = DEFAULT,
                     acquired_at = pg_catalog.statement_timestamp(),
                     renewed_at = pg_catalog.statement_timestamp(),
                     expires_at = pg_catalog.statement_timestamp()
                       + $7::pg_catalog.float8 * interval '1 millisecond',
                     released_at = NULL
                 WHERE project_id = $1
                   AND resource_type = $2
                   AND resource_key = $3
                   AND (
                     released_at IS NOT NULL
                     OR expires_at <= pg_catalog.statement_timestamp()
                   )
                 RETURNING project_id, resource_type, resource_key,
                           owner_machine_id, owner_process_id, operation,
                           fencing_token, acquired_at, renewed_at, expires_at,
                           released_at`,
          values,
        }, this.queryOptions(operation, input.signal));
      } else {
        const inserted = await executor.query<{
          fencing_token: unknown;
        }>({
          text: `INSERT INTO lcm.fenced_leases (
                   project_id,
                   resource_type,
                   resource_key,
                   owner_machine_id,
                   owner_process_id,
                   operation,
                   expires_at
                 )
                 VALUES (
                   $1, $2, $3, $4, $5, $6,
                   pg_catalog.statement_timestamp()
                     + $7::pg_catalog.float8 * interval '1 millisecond'
                 )
                 ON CONFLICT (
                   project_id,
                   resource_type,
                   resource_key
                 ) DO NOTHING
                 RETURNING fencing_token`,
          values,
        }, this.queryOptions(operation, input.signal));
        if (inserted.rows.length === 0) return null;
        if (inserted.rows.length !== 1) {
          return coordinationError(
            this.projectId,
            operation,
            "inserted_lease",
            this.machineId,
          );
        }
        const fencingToken = exactBigInt(
          inserted.rows[0]?.fencing_token,
          this.projectId,
          operation,
          "fencing_token",
          1n,
          this.machineId,
        );
        result = await executor.query<LeaseRow>({
          text: `UPDATE lcm.fenced_leases
                 SET acquired_at = pg_catalog.statement_timestamp(),
                     renewed_at = pg_catalog.statement_timestamp(),
                     expires_at = pg_catalog.statement_timestamp()
                       + $7::pg_catalog.float8 * interval '1 millisecond'
                 WHERE project_id = $1
                   AND resource_type = $2
                   AND resource_key = $3
                   AND owner_machine_id = $4
                   AND owner_process_id = $5
                   AND operation = $6
                   AND fencing_token = $8::pg_catalog.int8
                 RETURNING project_id, resource_type, resource_key,
                           owner_machine_id, owner_process_id, operation,
                           fencing_token, acquired_at, renewed_at, expires_at,
                           released_at`,
          values: [...values, fencingToken.toString()],
        }, this.queryOptions(operation, input.signal));
        if (result.rows.length !== 1) {
          return coordinationError(
            this.projectId,
            operation,
            "inserted_lease",
            this.machineId,
          );
        }
      }
      if (result.rows.length > 1) {
        return coordinationError(
          this.projectId,
          operation,
          "lease",
          this.machineId,
        );
      }
      const row = result.rows[0];
      return row
        ? leaseFromRow(row, this.projectId, operation, this.machineId)
        : null;
    });
  }

  async renewLease(
    input: PostgreSqlRenewLeaseInput,
  ): Promise<PostgreSqlFencedLease | null> {
    const operation = "renewLease";
    const normalized = this.leaseMutationInput(input, operation);
    const ttlMs = positiveSafeInteger(
      input.ttlMs,
      this.projectId,
      operation,
      "ttl_ms",
      this.machineId,
    );
    return this.atomic(operation, input.signal, async (executor) => {
      if (!await this.lockLeaseRow(
        executor,
        normalized,
        operation,
        input.signal,
      )) {
        return null;
      }
      const result = await executor.query<LeaseRow>({
        text: `UPDATE lcm.fenced_leases
               SET renewed_at = GREATEST(
                     pg_catalog.statement_timestamp(),
                     renewed_at
                   ),
                   expires_at = GREATEST(
                     pg_catalog.statement_timestamp(),
                     renewed_at
                   ) + $7::pg_catalog.float8 * interval '1 millisecond'
               WHERE project_id = $1
                 AND resource_type = $2
                 AND resource_key = $3
                 AND owner_machine_id = $4
                 AND owner_process_id = $5
                 AND operation = $6
                 AND fencing_token = $8::pg_catalog.int8
                 AND released_at IS NULL
                 AND expires_at > pg_catalog.statement_timestamp()
               RETURNING project_id, resource_type, resource_key,
                         owner_machine_id, owner_process_id, operation,
                         fencing_token, acquired_at, renewed_at, expires_at,
                         released_at`,
        values: [
          this.projectId,
          normalized.resourceType,
          normalized.resourceKey,
          this.machineId,
          normalized.processId,
          normalized.operation,
          ttlMs,
          normalized.fencingToken.toString(),
        ],
      }, this.queryOptions(operation, input.signal));
      const row = result.rows[0];
      return row
        ? leaseFromRow(row, this.projectId, operation, this.machineId)
        : null;
    });
  }

  async releaseLease(
    input: PostgreSqlLeaseMutationInput,
  ): Promise<PostgreSqlFencedLease | null> {
    const operation = "releaseLease";
    const normalized = this.leaseMutationInput(input, operation);
    return this.atomic(operation, input.signal, async (executor) => {
      const result = await executor.query<LeaseRow>({
        text: `UPDATE lcm.fenced_leases
               SET released_at = GREATEST(
                     pg_catalog.statement_timestamp(),
                     renewed_at
                   )
               WHERE project_id = $1
                 AND resource_type = $2
                 AND resource_key = $3
                 AND owner_machine_id = $4
                 AND owner_process_id = $5
                 AND operation = $6
                 AND fencing_token = $7::pg_catalog.int8
                 AND released_at IS NULL
               RETURNING project_id, resource_type, resource_key,
                         owner_machine_id, owner_process_id, operation,
                         fencing_token, acquired_at, renewed_at, expires_at,
                         released_at`,
        values: [
          this.projectId,
          normalized.resourceType,
          normalized.resourceKey,
          this.machineId,
          normalized.processId,
          normalized.operation,
          normalized.fencingToken.toString(),
        ],
      }, this.queryOptions(operation, input.signal));
      const row = result.rows[0];
      return row
        ? leaseFromRow(row, this.projectId, operation, this.machineId)
        : null;
    });
  }

  async assertLeaseFence(
    input: PostgreSqlLeaseMutationInput,
  ): Promise<PostgreSqlLeaseFenceValidation> {
    const operation = "assertLeaseFence";
    const normalized = this.leaseMutationInput(input, operation);
    const transaction = await this.transactionScope(operation);
    await this.assertReadCommitted(transaction, operation, input.signal);
    if (!await this.lockLeaseRow(
      transaction,
      normalized,
      operation,
      input.signal,
    )) {
      throw new PostgreSqlLeaseFenceError(
        this.projectId,
        this.machineId,
        normalized.fencingToken,
        operation,
      );
    }
    const result = await transaction.query<{
      fencing_token: unknown;
      validated_at: unknown;
    }>({
      text: `SELECT fencing_token,
                    pg_catalog.statement_timestamp() AS validated_at
             FROM lcm.fenced_leases
             WHERE project_id = $1
               AND resource_type = $2
               AND resource_key = $3
               AND owner_machine_id = $4
               AND owner_process_id = $5
               AND operation = $6
               AND fencing_token = $7::pg_catalog.int8
               AND released_at IS NULL
               AND expires_at > pg_catalog.statement_timestamp()
             FOR UPDATE`,
      values: [
        this.projectId,
        normalized.resourceType,
        normalized.resourceKey,
        this.machineId,
        normalized.processId,
        normalized.operation,
        normalized.fencingToken.toString(),
      ],
    }, this.queryOptions(operation, input.signal));
    const row = result.rows[0];
    if (
      result.rows.length !== 1
      || !row
      || exactBigInt(
        row.fencing_token,
        this.projectId,
        operation,
        "fencing_token",
        1n,
        this.machineId,
      ) !== normalized.fencingToken
    ) {
      throw new PostgreSqlLeaseFenceError(
        this.projectId,
        this.machineId,
        normalized.fencingToken,
        operation,
      );
    }
    return {
      projectId: this.projectId,
      machineId: this.machineId,
      resourceType: normalized.resourceType,
      resourceKey: normalized.resourceKey,
      processId: normalized.processId,
      operation: normalized.operation,
      fencingToken: normalized.fencingToken,
      validatedAt: timestamp(
        row.validated_at,
        this.projectId,
        operation,
        "validated_at",
        this.machineId,
      ),
    };
  }

  async listLeases(limit: number): Promise<PostgreSqlLeaseDiagnostic[]> {
    const operation = "listLeases";
    const normalizedLimit = positiveSafeInteger(
      limit,
      this.projectId,
      operation,
      "limit",
      this.machineId,
    );
    const result = await this.coordinationExecutor.query<LeaseDiagnosticRow>({
      text: `SELECT project_id, resource_type, resource_key,
                    owner_machine_id, owner_process_id, operation,
                    fencing_token, acquired_at, renewed_at, expires_at,
                    released_at,
                    CASE
                      WHEN released_at IS NOT NULL THEN 'released'
                      WHEN expires_at <= pg_catalog.statement_timestamp()
                        THEN 'expired'
                      ELSE 'active'
                    END AS state
             FROM lcm.fenced_leases
             WHERE project_id = $1
             ORDER BY
               CASE
                 WHEN released_at IS NULL
                  AND expires_at > pg_catalog.statement_timestamp() THEN 0
                 WHEN released_at IS NULL THEN 1
                 ELSE 2
               END,
               expires_at,
               resource_type,
               resource_key
             LIMIT $2`,
      values: [this.projectId, normalizedLimit],
    }, this.queryOptions(operation));
    return result.rows.map((row) => {
      const lease = leaseFromRow(row, this.projectId, operation);
      const state = row.state;
      if (
        state !== "active"
        && state !== "expired"
        && state !== "released"
      ) {
        return coordinationError(
          this.projectId,
          operation,
          "state",
          lease.machineId,
        );
      }
      return { ...lease, state };
    });
  }

  async cleanupLeases(
    input: PostgreSqlLeaseCleanupInput,
  ): Promise<PostgreSqlLeaseCleanup> {
    const operation = "cleanupLeases";
    const retentionMs = positiveSafeInteger(
      input.retentionMs,
      this.projectId,
      operation,
      "retention_ms",
      this.machineId,
    );
    const limit = positiveSafeInteger(
      input.limit,
      this.projectId,
      operation,
      "limit",
      this.machineId,
    );
    return this.atomic(operation, input.signal, async (executor) => {
      const result = await executor.query<CountRow>({
        text: `WITH candidates AS (
                 SELECT project_id, resource_type, resource_key
                 FROM lcm.fenced_leases
                 WHERE project_id = $1
                   AND COALESCE(released_at, expires_at)
                         <= pg_catalog.statement_timestamp()
                           - $2::pg_catalog.float8
                             * interval '1 millisecond'
                 ORDER BY COALESCE(released_at, expires_at),
                          resource_type,
                          resource_key
                 FOR UPDATE SKIP LOCKED
                 LIMIT $3
               ),
               deleted AS (
                 DELETE FROM lcm.fenced_leases AS lease
                 USING candidates
                 WHERE lease.project_id = candidates.project_id
                   AND lease.resource_type = candidates.resource_type
                   AND lease.resource_key = candidates.resource_key
                 RETURNING 1
               )
               SELECT COUNT(*)::pg_catalog.text AS count
               FROM deleted`,
        values: [this.projectId, retentionMs, limit],
      }, this.queryOptions(operation, input.signal));
      return {
        projectId: this.projectId,
        deletedCount: exactBigInt(
          result.rows[0]?.count,
          this.projectId,
          operation,
          "count",
          0n,
          this.machineId,
        ),
      };
    });
  }

  async claimPassiveEvents(
    input: PostgreSqlClaimPassiveEventsInput,
  ): Promise<PostgreSqlPassiveEventClaim[]> {
    const operation = "claimPassiveEvents";
    const claimOwner = nonblankText(
      input.claimOwner,
      this.projectId,
      operation,
      "claim_owner",
      this.machineId,
    );
    const limit = positiveSafeInteger(
      input.limit,
      this.projectId,
      operation,
      "limit",
      this.machineId,
    );
    const staleClaimMs = positiveSafeInteger(
      input.staleClaimMs,
      this.projectId,
      operation,
      "stale_claim_ms",
      this.machineId,
    );
    return this.atomic(operation, input.signal, async (executor) => {
      const result = await executor.query<PassiveEventClaimRow>({
        text: `WITH candidates AS (
                 SELECT event.inbox_id
                 FROM lcm.passive_event_inbox AS event
                 WHERE event.project_id = $1
                   AND (
                     (
                       event.status IN ('pending', 'retry')
                       AND event.next_attempt_at
                             <= pg_catalog.statement_timestamp()
                     )
                     OR (
                       event.status = 'claimed'
                       AND event.claimed_at
                             <= pg_catalog.statement_timestamp()
                               - $4::pg_catalog.float8
                                 * interval '1 millisecond'
                     )
                   )
                   AND NOT EXISTS (
                     SELECT 1
                     FROM lcm.passive_event_inbox AS earlier
                     WHERE earlier.project_id = event.project_id
                       AND earlier.machine_id = event.machine_id
                       AND earlier.machine_sequence < event.machine_sequence
                       AND earlier.status NOT IN ('applied', 'quarantined')
                   )
                 ORDER BY
                   CASE
                     WHEN event.status = 'claimed' THEN event.claimed_at
                     ELSE event.next_attempt_at
                   END,
                   event.received_at,
                   event.machine_id,
                   event.machine_sequence,
                   event.inbox_id
                 FOR UPDATE OF event SKIP LOCKED
                 LIMIT $3
               ),
               claimed AS (
                 UPDATE lcm.passive_event_inbox AS event
                 SET status = 'claimed',
                     attempt_count = event.attempt_count + 1,
                     claimed_at = GREATEST(
                       pg_catalog.statement_timestamp(),
                       event.received_at
                     ),
                     claimed_by = $2
                 FROM candidates
                 WHERE event.project_id = $1
                   AND event.inbox_id = candidates.inbox_id
                 RETURNING event.inbox_id, event.project_id,
                           event.machine_id, event.event_id,
                           event.event_version, event.machine_sequence,
                           event.event_type, event.payload,
                           event.attempt_count, event.received_at,
                           event.next_attempt_at, event.claimed_at,
                           event.claimed_by
               )
               SELECT *
               FROM claimed
               ORDER BY received_at, machine_id, machine_sequence, inbox_id`,
        values: [
          this.projectId,
          claimOwner,
          limit,
          staleClaimMs,
        ],
      }, this.queryOptions(operation, input.signal));
      return result.rows.map((row) =>
        passiveEventClaimFromRow(row, this.projectId, operation));
    });
  }

  async getCoordinationDiagnostics(): Promise<
    PostgreSqlCoordinationDiagnostics
  > {
    const operation = "getCoordinationDiagnostics";
    const result = await this.coordinationExecutor.query<DiagnosticsRow>({
      text: `SELECT
               (
                 SELECT COUNT(*)::pg_catalog.text
                 FROM lcm.fenced_leases
                 WHERE project_id = $1
                   AND released_at IS NULL
                   AND expires_at > pg_catalog.statement_timestamp()
               ) AS active_leases,
               (
                 SELECT COUNT(*)::pg_catalog.text
                 FROM lcm.fenced_leases
                 WHERE project_id = $1
                   AND released_at IS NULL
                   AND expires_at <= pg_catalog.statement_timestamp()
               ) AS expired_leases,
               (
                 SELECT COUNT(*)::pg_catalog.text
                 FROM lcm.fenced_leases
                 WHERE project_id = $1
                   AND released_at IS NOT NULL
               ) AS released_leases,
               (
                 SELECT MIN(expires_at)
                 FROM lcm.fenced_leases
                 WHERE project_id = $1
                   AND released_at IS NULL
                   AND expires_at > pg_catalog.statement_timestamp()
               ) AS oldest_active_expiry_at,
               COUNT(*) FILTER (WHERE status = 'pending')::pg_catalog.text
                 AS pending_events,
               COUNT(*) FILTER (WHERE status = 'claimed')::pg_catalog.text
                 AS claimed_events,
               COUNT(*) FILTER (WHERE status = 'retry')::pg_catalog.text
                 AS retry_events,
               COUNT(*) FILTER (WHERE status = 'applied')::pg_catalog.text
                 AS applied_events,
               COUNT(*) FILTER (WHERE status = 'quarantined')::pg_catalog.text
                 AS quarantined_events,
               MIN(next_attempt_at) FILTER (
                 WHERE status IN ('pending', 'retry')
               ) AS oldest_ready_at,
               MIN(claimed_at) FILTER (
                 WHERE status = 'claimed'
               ) AS oldest_claimed_at
             FROM lcm.passive_event_inbox
             WHERE project_id = $1`,
      values: [this.projectId],
    }, this.queryOptions(operation));
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row) {
      return coordinationError(
        this.projectId,
        operation,
        "diagnostics",
        this.machineId,
      );
    }
    return {
      leases: {
        active: exactBigInt(
          row.active_leases,
          this.projectId,
          operation,
          "active_leases",
          0n,
          this.machineId,
        ),
        expired: exactBigInt(
          row.expired_leases,
          this.projectId,
          operation,
          "expired_leases",
          0n,
          this.machineId,
        ),
        released: exactBigInt(
          row.released_leases,
          this.projectId,
          operation,
          "released_leases",
          0n,
          this.machineId,
        ),
        oldestActiveExpiryAt: nullableTimestamp(
          row.oldest_active_expiry_at,
          this.projectId,
          operation,
          "oldest_active_expiry_at",
          this.machineId,
        ),
      },
      queue: {
        pending: exactBigInt(
          row.pending_events,
          this.projectId,
          operation,
          "pending_events",
          0n,
          this.machineId,
        ),
        claimed: exactBigInt(
          row.claimed_events,
          this.projectId,
          operation,
          "claimed_events",
          0n,
          this.machineId,
        ),
        retry: exactBigInt(
          row.retry_events,
          this.projectId,
          operation,
          "retry_events",
          0n,
          this.machineId,
        ),
        applied: exactBigInt(
          row.applied_events,
          this.projectId,
          operation,
          "applied_events",
          0n,
          this.machineId,
        ),
        quarantined: exactBigInt(
          row.quarantined_events,
          this.projectId,
          operation,
          "quarantined_events",
          0n,
          this.machineId,
        ),
        oldestReadyAt: nullableTimestamp(
          row.oldest_ready_at,
          this.projectId,
          operation,
          "oldest_ready_at",
          this.machineId,
        ),
        oldestClaimedAt: nullableTimestamp(
          row.oldest_claimed_at,
          this.projectId,
          operation,
          "oldest_claimed_at",
          this.machineId,
        ),
      },
    };
  }

  private acquireLeaseInput(
    input: PostgreSqlAcquireLeaseInput,
    operation: string,
  ): PostgreSqlCoordinationResource & {
    readonly processId: string;
    readonly operation: string;
    readonly ttlMs: number;
  } {
    return {
      ...resource(input, this.projectId, operation, this.machineId),
      processId: nonblankText(
        input.processId,
        this.projectId,
        operation,
        "owner_process_id",
        this.machineId,
      ),
      operation: nonblankText(
        input.operation,
        this.projectId,
        operation,
        "lease_operation",
        this.machineId,
      ),
      ttlMs: positiveSafeInteger(
        input.ttlMs,
        this.projectId,
        operation,
        "ttl_ms",
        this.machineId,
      ),
    };
  }

  private leaseMutationInput(
    input: PostgreSqlLeaseMutationInput,
    operation: string,
  ): PostgreSqlCoordinationResource & {
    readonly processId: string;
    readonly operation: string;
    readonly fencingToken: bigint;
  } {
    return {
      ...resource(input, this.projectId, operation, this.machineId),
      processId: nonblankText(
        input.processId,
        this.projectId,
        operation,
        "owner_process_id",
        this.machineId,
      ),
      operation: nonblankText(
        input.operation,
        this.projectId,
        operation,
        "lease_operation",
        this.machineId,
      ),
      fencingToken: exactBigInt(
        input.fencingToken,
        this.projectId,
        operation,
        "fencing_token",
        1n,
        this.machineId,
      ),
    };
  }

  private async lockLeaseRow(
    executor: PostgreSqlQueryExecutor,
    lease: PostgreSqlCoordinationResource,
    operation: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const result = await executor.query({
      text: `SELECT 1 AS locked
             FROM lcm.fenced_leases
             WHERE project_id = $1
               AND resource_type = $2
               AND resource_key = $3
             FOR UPDATE`,
      values: [
        this.projectId,
        lease.resourceType,
        lease.resourceKey,
      ],
    }, this.queryOptions(operation, signal));
    if (result.rows.length > 1) {
      return coordinationError(
        this.projectId,
        operation,
        "lease_lock",
        this.machineId,
      );
    }
    return result.rows.length === 1;
  }

  private context(
    operation: string,
    signal?: AbortSignal,
  ): CoordinationContext {
    return {
      domain: "coordination",
      operation,
      projectId: this.projectId,
      machineId: this.machineId,
      ...(signal === undefined ? {} : { signal }),
    };
  }

  private queryOptions(
    operation: string,
    signal?: AbortSignal,
  ): PostgreSqlQueryOptions {
    return this.context(operation, signal);
  }

  private async atomic<T>(
    operation: string,
    signal: AbortSignal | undefined,
    callback: (executor: PostgreSqlQueryExecutor) => Promise<T>,
  ): Promise<T> {
    if (
      "transaction" in this.coordinationExecutor
      && typeof this.coordinationExecutor.transaction === "function"
    ) {
      return this.coordinationExecutor.transaction(async (transaction) => {
        await transaction.query({
          text: "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
        }, this.queryOptions(operation, signal));
        return callback(transaction);
      }, this.context(operation, signal));
    }
    const transaction = await this.transactionScope(operation);
    await this.assertReadCommitted(transaction, operation, signal);
    return transaction.savepoint(
      callback,
      this.queryOptions(operation, signal),
    );
  }

  private async transactionScope(
    operation: string,
  ): Promise<PostgreSqlTransactionScopeExecutor> {
    if (
      this.coordinationExecutor.transactionScope !== "active"
      || !("savepoint" in this.coordinationExecutor)
      || typeof this.coordinationExecutor.savepoint !== "function"
    ) {
      throw new StorageOperationError(
        "STORAGE_TRANSACTION_SCOPE",
        "postgresql",
        this.projectId,
        "coordination",
        operation,
      );
    }
    return this.coordinationExecutor;
  }

  private async assertReadCommitted(
    executor: PostgreSqlQueryExecutor,
    operation: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await executor.query<IsolationRow>({
      text: `SELECT pg_catalog.current_setting(
                      'transaction_isolation'
                    ) AS transaction_isolation`,
    }, this.queryOptions(operation, signal));
    const isolation = text(
      result.rows[0]?.transaction_isolation,
      this.projectId,
      operation,
      "transaction_isolation",
      this.machineId,
    );
    if (isolation.trim().toLowerCase() !== "read committed") {
      return coordinationError(
        this.projectId,
        operation,
        "transaction_isolation",
        this.machineId,
      );
    }
  }
}
