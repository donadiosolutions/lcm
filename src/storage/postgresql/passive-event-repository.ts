import type { QueryResultRow } from "pg";
import type { JsonObject } from "../contracts.js";
import { StorageOperationError } from "../errors.js";
import {
  PostgreSqlWorkCoordinator,
  type PostgreSqlClaimPassiveEventsInput,
  type PostgreSqlCoordinationDiagnostics,
  type PostgreSqlCoordinationExecutor,
  type PostgreSqlFencedLease,
  type PostgreSqlPassiveEventClaim,
} from "./coordination.js";
import type {
  PostgreSqlOperationContext,
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
  PostgreSqlTransactionScopeExecutor,
} from "./contracts.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[457][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UUIDV7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DECIMAL_BIGINT_PATTERN = /^\d+$/u;
const MAX_BATCH_SIZE = 500;
const MAX_POSTGRESQL_INTEGER = 2_147_483_647;
const MAX_POSTGRESQL_BIGINT = 9_223_372_036_854_775_807n;
const DRAIN_RESOURCE_TYPE = "passive-events";
const DRAIN_OPERATION = "replicate";

export type PostgreSqlPassiveEventStatus =
  | "pending"
  | "claimed"
  | "retry"
  | "applied"
  | "quarantined";

export interface PostgreSqlPassiveEventKey {
  readonly machineId: string;
  readonly eventId: string;
}

export interface PostgreSqlPassiveEventInput extends PostgreSqlPassiveEventKey {
  readonly eventVersion: number;
  readonly machineSequence: bigint;
  readonly eventType: string;
  readonly payload: JsonObject;
}

export interface PostgreSqlPassiveEventRecord
extends PostgreSqlPassiveEventInput {
  readonly inboxId: bigint;
  readonly projectId: string;
  readonly status: PostgreSqlPassiveEventStatus;
  readonly attemptCount: number;
  readonly receivedAt: string;
  readonly nextAttemptAt: string;
  readonly claimedAt: string | null;
  readonly claimedBy: string | null;
  readonly appliedAt: string | null;
  readonly quarantinedAt: string | null;
  readonly quarantineReason: string | null;
}

export interface PostgreSqlPassiveEventFence {
  readonly processId: string;
  readonly fencingToken: bigint;
  readonly signal?: AbortSignal;
}

export interface PostgreSqlPassiveEventClaimMutation
extends PostgreSqlPassiveEventFence {
  readonly claim: PostgreSqlPassiveEventClaim;
}

export interface PostgreSqlPassiveEventRetryInput
extends PostgreSqlPassiveEventClaimMutation {
  readonly delayMs: number;
}

export interface PostgreSqlPassiveEventQuarantineInput
extends PostgreSqlPassiveEventClaimMutation {
  readonly reason: string;
}

export interface PostgreSqlPassiveEventPruneKey
extends PostgreSqlPassiveEventKey {
  readonly inboxId: bigint;
}

type PassiveEventRow = QueryResultRow & {
  inbox_id: unknown;
  project_id: unknown;
  machine_id: unknown;
  event_id: unknown;
  event_version: unknown;
  machine_sequence: unknown;
  event_type: unknown;
  payload: unknown;
  status: unknown;
  attempt_count: unknown;
  received_at: unknown;
  next_attempt_at: unknown;
  claimed_at: unknown;
  claimed_by: unknown;
  applied_at: unknown;
  quarantined_at: unknown;
  quarantine_reason: unknown;
};

export type PostgreSqlPassiveEventRepositoryExecutor =
  | PostgreSqlCoordinationExecutor
  | PostgreSqlTransactionScopeExecutor;

export class PostgreSqlPassiveEventDataError extends StorageOperationError {
  constructor(
    projectId: string,
    readonly field: string,
    readonly eventId?: string,
  ) {
    super(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      projectId,
      "passive-events",
      "validate",
    );
    this.name = "PostgreSqlPassiveEventDataError";
  }
}

function dataError(projectId: string, field: string, eventId?: string): never {
  throw new PostgreSqlPassiveEventDataError(projectId, field, eventId);
}

function uuid(
  value: unknown,
  projectId: string,
  field: string,
  eventId?: string,
): string {
  if (typeof value !== "string") return dataError(projectId, field, eventId);
  const normalized = value.toLowerCase();
  return UUID_PATTERN.test(normalized)
    ? normalized
    : dataError(projectId, field, eventId);
}

function uuidV7(
  value: unknown,
  projectId: string,
  field: string,
  eventId?: string,
): string {
  const normalized = uuid(value, projectId, field, eventId);
  return UUIDV7_PATTERN.test(normalized)
    ? normalized
    : dataError(projectId, field, eventId);
}

function nonblank(
  value: unknown,
  projectId: string,
  field: string,
  eventId?: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return dataError(projectId, field, eventId);
  }
  return postgresqlText(value, projectId, field, eventId);
}

function postgresqlText(
  value: string,
  projectId: string,
  field: string,
  eventId?: string,
): string {
  if (value.includes("\0")) return dataError(projectId, field, eventId);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) {
        return dataError(projectId, field, eventId);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return dataError(projectId, field, eventId);
    }
  }
  return value;
}

function exactBigInt(
  value: unknown,
  projectId: string,
  field: string,
  minimum: bigint,
  eventId?: string,
): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (
    typeof value === "number"
    && Number.isSafeInteger(value)
  ) {
    parsed = BigInt(value);
  } else if (
    typeof value === "string"
    && DECIMAL_BIGINT_PATTERN.test(value)
  ) {
    parsed = BigInt(value);
  } else {
    return dataError(projectId, field, eventId);
  }
  return parsed >= minimum && parsed <= MAX_POSTGRESQL_BIGINT
    ? parsed
    : dataError(projectId, field, eventId);
}

function safeInteger(
  value: unknown,
  projectId: string,
  field: string,
  minimum: number,
  eventId?: string,
): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/u.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= minimum
    ? parsed
    : dataError(projectId, field, eventId);
}

function postgresqlInteger(
  value: unknown,
  projectId: string,
  field: string,
  minimum: number,
  eventId?: string,
): number {
  const parsed = safeInteger(value, projectId, field, minimum, eventId);
  return parsed <= MAX_POSTGRESQL_INTEGER
    ? parsed
    : dataError(projectId, field, eventId);
}

function timestamp(
  value: unknown,
  projectId: string,
  field: string,
  eventId?: string,
): string {
  if (!(value instanceof Date) && typeof value !== "string") {
    return dataError(projectId, field, eventId);
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf())
    ? dataError(projectId, field, eventId)
    : date.toISOString();
}

function nullableTimestamp(
  value: unknown,
  projectId: string,
  field: string,
  eventId?: string,
): string | null {
  return value === null
    ? null
    : timestamp(value, projectId, field, eventId);
}

function nullableText(
  value: unknown,
  projectId: string,
  field: string,
  eventId?: string,
): string | null {
  return value === null
    ? null
    : nonblank(value, projectId, field, eventId);
}

function jsonObject(
  value: unknown,
  projectId: string,
  eventId?: string,
): JsonObject {
  const seen = new Set<object>();
  const validate = (candidate: unknown): void => {
    if (
      candidate === null
      || typeof candidate === "boolean"
    ) {
      return;
    }
    if (typeof candidate === "string") {
      postgresqlText(candidate, projectId, "payload", eventId);
      return;
    }
    if (typeof candidate === "number") {
      if (Number.isFinite(candidate)) return;
      return dataError(projectId, "payload", eventId);
    }
    if (typeof candidate !== "object") {
      return dataError(projectId, "payload", eventId);
    }
    if (seen.has(candidate)) return dataError(projectId, "payload", eventId);
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const child of candidate) validate(child);
    } else {
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        return dataError(projectId, "payload", eventId);
      }
      for (const [key, child] of Object.entries(candidate)) {
        postgresqlText(key, projectId, "payload", eventId);
        validate(child);
      }
    }
    seen.delete(candidate);
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return dataError(projectId, "payload", eventId);
  }
  validate(value);
  return value as JsonObject;
}

function status(
  value: unknown,
  projectId: string,
  eventId?: string,
): PostgreSqlPassiveEventStatus {
  if (
    value === "pending"
    || value === "claimed"
    || value === "retry"
    || value === "applied"
    || value === "quarantined"
  ) {
    return value;
  }
  return dataError(projectId, "status", eventId);
}

function passiveEventFromRow(
  row: PassiveEventRow,
  projectId: string,
): PostgreSqlPassiveEventRecord {
  const eventId = uuid(row.event_id, projectId, "event_id");
  const rowProjectId = uuidV7(row.project_id, projectId, "project_id", eventId);
  if (rowProjectId !== projectId) {
    return dataError(projectId, "project_id", eventId);
  }
  const machineId = uuidV7(row.machine_id, projectId, "machine_id", eventId);
  const parsedStatus = status(row.status, projectId, eventId);
  const claimedAt = nullableTimestamp(row.claimed_at, projectId, "claimed_at", eventId);
  const claimedBy = nullableText(row.claimed_by, projectId, "claimed_by", eventId);
  const appliedAt = nullableTimestamp(row.applied_at, projectId, "applied_at", eventId);
  const quarantinedAt = nullableTimestamp(
    row.quarantined_at,
    projectId,
    "quarantined_at",
    eventId,
  );
  const quarantineReason = nullableText(
    row.quarantine_reason,
    projectId,
    "quarantine_reason",
    eventId,
  );
  if (
    (parsedStatus === "claimed") !== (claimedAt !== null && claimedBy !== null)
    || (parsedStatus === "applied") !== (appliedAt !== null)
    || (parsedStatus === "quarantined")
      !== (quarantinedAt !== null && quarantineReason !== null)
  ) {
    return dataError(projectId, "status_timestamps", eventId);
  }
  return {
    inboxId: exactBigInt(row.inbox_id, projectId, "inbox_id", 1n, eventId),
    projectId: rowProjectId,
    machineId,
    eventId,
    eventVersion: postgresqlInteger(
      row.event_version,
      projectId,
      "event_version",
      1,
      eventId,
    ),
    machineSequence: exactBigInt(
      row.machine_sequence,
      projectId,
      "machine_sequence",
      0n,
      eventId,
    ),
    eventType: nonblank(row.event_type, projectId, "event_type", eventId),
    payload: jsonObject(row.payload, projectId, eventId),
    status: parsedStatus,
    attemptCount: postgresqlInteger(
      row.attempt_count,
      projectId,
      "attempt_count",
      0,
      eventId,
    ),
    receivedAt: timestamp(row.received_at, projectId, "received_at", eventId),
    nextAttemptAt: timestamp(row.next_attempt_at, projectId, "next_attempt_at", eventId),
    claimedAt,
    claimedBy,
    appliedAt,
    quarantinedAt,
    quarantineReason,
  };
}

function normalizedInput(
  input: PostgreSqlPassiveEventInput,
  projectId: string,
  repositoryMachineId: string,
): PostgreSqlPassiveEventInput {
  const eventId = uuid(input.eventId, projectId, "event_id");
  const machineId = uuidV7(input.machineId, projectId, "machine_id", eventId);
  if (machineId !== repositoryMachineId) {
    return dataError(projectId, "machine_id", eventId);
  }
  const eventVersion = postgresqlInteger(
    input.eventVersion,
    projectId,
    "event_version",
    1,
    eventId,
  );
  const machineSequence = exactBigInt(
    input.machineSequence,
    projectId,
    "machine_sequence",
    0n,
    eventId,
  );
  return {
    eventId,
    machineId,
    eventVersion,
    machineSequence,
    eventType: nonblank(input.eventType, projectId, "event_type", eventId),
    payload: jsonObject(input.payload, projectId, eventId),
  };
}

function normalizedClaim(
  claim: PostgreSqlPassiveEventClaim,
  projectId: string,
): PostgreSqlPassiveEventClaim {
  const eventId = uuid(claim.eventId, projectId, "event_id");
  const claimProjectId = uuidV7(
    claim.projectId,
    projectId,
    "project_id",
    eventId,
  );
  if (claimProjectId !== projectId) {
    return dataError(projectId, "project_id", eventId);
  }
  return {
    inboxId: exactBigInt(claim.inboxId, projectId, "inbox_id", 1n, eventId),
    projectId: claimProjectId,
    machineId: uuidV7(claim.machineId, projectId, "machine_id", eventId),
    eventId,
    eventVersion: postgresqlInteger(
      claim.eventVersion,
      projectId,
      "event_version",
      1,
      eventId,
    ),
    machineSequence: exactBigInt(
      claim.machineSequence,
      projectId,
      "machine_sequence",
      0n,
      eventId,
    ),
    eventType: nonblank(claim.eventType, projectId, "event_type", eventId),
    payload: jsonObject(claim.payload, projectId, eventId),
    attemptCount: postgresqlInteger(
      claim.attemptCount,
      projectId,
      "attempt_count",
      0,
      eventId,
    ),
    receivedAt: timestamp(claim.receivedAt, projectId, "received_at", eventId),
    nextAttemptAt: timestamp(
      claim.nextAttemptAt,
      projectId,
      "next_attempt_at",
      eventId,
    ),
    claimedAt: timestamp(claim.claimedAt, projectId, "claimed_at", eventId),
    claimedBy: nonblank(claim.claimedBy, projectId, "claimed_by", eventId),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertSameEvent(
  expected: PostgreSqlPassiveEventInput,
  actual: PostgreSqlPassiveEventRecord,
  projectId: string,
): void {
  if (
    actual.machineId !== expected.machineId
    || actual.eventId !== expected.eventId
    || actual.eventVersion !== expected.eventVersion
    || actual.machineSequence !== expected.machineSequence
    || actual.eventType !== expected.eventType
    || canonicalJson(actual.payload) !== canonicalJson(expected.payload)
  ) {
    dataError(projectId, "idempotency_collision", expected.eventId);
  }
}

function claimFromRecord(
  record: PostgreSqlPassiveEventRecord,
  projectId: string,
): PostgreSqlPassiveEventClaim {
  if (
    record.status !== "claimed"
    || record.claimedAt === null
    || record.claimedBy === null
  ) {
    return dataError(projectId, "claimed_row", record.eventId);
  }
  return {
    inboxId: record.inboxId,
    projectId: record.projectId,
    machineId: record.machineId,
    eventId: record.eventId,
    eventVersion: record.eventVersion,
    machineSequence: record.machineSequence,
    eventType: record.eventType,
    payload: record.payload,
    attemptCount: record.attemptCount,
    receivedAt: record.receivedAt,
    nextAttemptAt: record.nextAttemptAt,
    claimedAt: record.claimedAt,
    claimedBy: record.claimedBy,
  };
}

function assertSameClaim(
  expected: PostgreSqlPassiveEventClaim,
  actual: PostgreSqlPassiveEventClaim,
  projectId: string,
): void {
  if (
    expected.inboxId !== actual.inboxId
    || expected.projectId !== actual.projectId
    || expected.machineId !== actual.machineId
    || expected.eventId !== actual.eventId
    || expected.eventVersion !== actual.eventVersion
    || expected.machineSequence !== actual.machineSequence
    || expected.eventType !== actual.eventType
    || canonicalJson(expected.payload) !== canonicalJson(actual.payload)
    || expected.attemptCount !== actual.attemptCount
    || expected.receivedAt !== actual.receivedAt
    || expected.nextAttemptAt !== actual.nextAttemptAt
    || expected.claimedAt !== actual.claimedAt
    || expected.claimedBy !== actual.claimedBy
  ) {
    dataError(projectId, "claimed_snapshot", expected.eventId);
  }
}

function batchSize(length: number): void {
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_BATCH_SIZE) {
    throw new Error(`passive-event batch must contain 1-${MAX_BATCH_SIZE} events`);
  }
}

export class PostgreSqlPassiveEventRepository {
  readonly projectId: string;
  readonly machineId: string;
  readonly coordinator: PostgreSqlWorkCoordinator;

  constructor(
    private readonly executor: PostgreSqlPassiveEventRepositoryExecutor,
    projectId: string,
    machineId: string,
  ) {
    this.coordinator = new PostgreSqlWorkCoordinator(executor, projectId, machineId);
    this.projectId = this.coordinator.projectId;
    this.machineId = this.coordinator.machineId;
  }

  async insertEvents(
    inputs: readonly PostgreSqlPassiveEventInput[],
    signal?: AbortSignal,
  ): Promise<PostgreSqlPassiveEventRecord[]> {
    batchSize(inputs.length);
    const normalized = inputs.map((input) =>
      normalizedInput(input, this.projectId, this.machineId));
    const distinct = new Set(normalized.map(({ eventId }) => eventId));
    if (distinct.size !== normalized.length) {
      return dataError(this.projectId, "duplicate_batch_event_id");
    }
    return this.atomic("insertEvents", signal, async (transaction) => {
      for (const input of normalized) {
        await transaction.query({
          text: `INSERT INTO lcm.passive_event_inbox(
                   project_id, machine_id, event_id, event_version,
                   machine_sequence, event_type, payload
                 ) VALUES(
                   $1, $2, $3, $4, $5::pg_catalog.int8, $6, $7::pg_catalog.jsonb
                 )
                 ON CONFLICT DO NOTHING`,
          values: [
            this.projectId,
            input.machineId,
            input.eventId,
            input.eventVersion,
            input.machineSequence.toString(),
            input.eventType,
            JSON.stringify(input.payload),
          ],
        }, this.options("insertEvents", signal));
      }
      const records = await this.readEventsWithExecutor(
        transaction,
        normalized.map(({ machineId, eventId }) => ({ machineId, eventId })),
        "insertEvents",
        signal,
      );
      if (records.length !== normalized.length) {
        const returned = new Set(records.map(({ eventId }) => eventId));
        let missing: PostgreSqlPassiveEventInput | undefined;
        for (const input of normalized) {
          if (!returned.has(input.eventId)) {
            missing = input;
            break;
          }
        }
        return dataError(
          this.projectId,
          "idempotency_readback",
          missing?.eventId,
        );
      }
      const byId = new Map(records.map((record) => [record.eventId, record]));
      return normalized.map((input) => {
        const record = byId.get(input.eventId);
        if (!record) return dataError(this.projectId, "idempotency_readback", input.eventId);
        assertSameEvent(input, record, this.projectId);
        return record;
      });
    });
  }

  async readEvents(
    keys: readonly PostgreSqlPassiveEventKey[],
    signal?: AbortSignal,
  ): Promise<PostgreSqlPassiveEventRecord[]> {
    batchSize(keys.length);
    return this.readEventsWithExecutor(this.executor, keys, "readEvents", signal);
  }

  async readEvent(
    key: PostgreSqlPassiveEventKey,
    signal?: AbortSignal,
  ): Promise<PostgreSqlPassiveEventRecord | null> {
    const records = await this.readEvents([key], signal);
    return records[0] ?? null;
  }

  claimEvents(
    input: PostgreSqlClaimPassiveEventsInput,
  ): Promise<PostgreSqlPassiveEventClaim[]> {
    return this.coordinator.claimPassiveEvents(input);
  }

  getDiagnostics(): Promise<PostgreSqlCoordinationDiagnostics> {
    return this.coordinator.getCoordinationDiagnostics();
  }

  acquireDrainLease(
    processId: string,
    ttlMs: number,
    signal?: AbortSignal,
  ): Promise<PostgreSqlFencedLease | null> {
    return this.coordinator.acquireLease({
      resourceType: DRAIN_RESOURCE_TYPE,
      resourceKey: this.machineId,
      processId,
      operation: DRAIN_OPERATION,
      ttlMs,
      signal,
    });
  }

  releaseDrainLease(
    processId: string,
    fencingToken: bigint,
    signal?: AbortSignal,
  ): Promise<PostgreSqlFencedLease | null> {
    return this.coordinator.releaseLease({
      resourceType: DRAIN_RESOURCE_TYPE,
      resourceKey: this.machineId,
      processId,
      operation: DRAIN_OPERATION,
      fencingToken,
      signal,
    });
  }

  renewDrainLease(
    processId: string,
    fencingToken: bigint,
    ttlMs: number,
    signal?: AbortSignal,
  ): Promise<PostgreSqlFencedLease | null> {
    return this.coordinator.renewLease({
      resourceType: DRAIN_RESOURCE_TYPE,
      resourceKey: this.machineId,
      processId,
      operation: DRAIN_OPERATION,
      fencingToken,
      ttlMs,
      signal,
    });
  }

  async completeApplied<T>(
    input: PostgreSqlPassiveEventClaimMutation,
    apply: (
      executor: PostgreSqlQueryExecutor,
      claim: PostgreSqlPassiveEventClaim,
    ) => Promise<T>,
  ): Promise<{ readonly event: PostgreSqlPassiveEventRecord; readonly result: T }> {
    return this.atomic("completeApplied", input.signal, async (transaction, scope) => {
      await this.assertFence(scope, input);
      const claim = await this.assertClaim(
        transaction,
        input.claim,
        "completeApplied",
        input.signal,
      );
      const result = await apply(transaction, claim);
      const updated = await transaction.query<PassiveEventRow>({
        text: `UPDATE lcm.passive_event_inbox
               SET status = 'applied',
                   claimed_at = NULL,
                   claimed_by = NULL,
                   applied_at = GREATEST(
                     pg_catalog.clock_timestamp(),
                     received_at
                   ),
                   quarantined_at = NULL,
                   quarantine_reason = NULL
               WHERE project_id = $1
                 AND inbox_id = $2::pg_catalog.int8
                 AND machine_id = $3
                 AND event_id = $4
                 AND status = 'claimed'
                 AND claimed_by = $5
               RETURNING *`,
        values: [
          this.projectId,
          claim.inboxId.toString(),
          claim.machineId,
          claim.eventId,
          claim.claimedBy,
        ],
      }, this.options("completeApplied", input.signal));
      if (updated.rows.length !== 1 || !updated.rows[0]) {
        return dataError(this.projectId, "claimed_transition", claim.eventId);
      }
      return {
        event: passiveEventFromRow(updated.rows[0], this.projectId),
        result,
      };
    });
  }

  async scheduleRetry(
    input: PostgreSqlPassiveEventRetryInput,
  ): Promise<PostgreSqlPassiveEventRecord> {
    if (!Number.isSafeInteger(input.delayMs) || input.delayMs < 0) {
      throw new Error("passive-event retry delay must be a non-negative safe integer");
    }
    return this.claimTransition(
      "scheduleRetry",
      input,
      `status = 'retry',
       next_attempt_at = GREATEST(
         received_at,
         pg_catalog.clock_timestamp()
           + $6::pg_catalog.float8 * interval '1 millisecond'
       ),
       claimed_at = NULL,
       claimed_by = NULL,
       applied_at = NULL,
       quarantined_at = NULL,
       quarantine_reason = NULL`,
      [input.delayMs],
    );
  }

  async quarantine(
    input: PostgreSqlPassiveEventQuarantineInput,
  ): Promise<PostgreSqlPassiveEventRecord> {
    const reason = nonblank(
      input.reason,
      this.projectId,
      "quarantine_reason",
      input.claim.eventId,
    );
    return this.claimTransition(
      "quarantine",
      input,
      `status = 'quarantined',
       claimed_at = NULL,
       claimed_by = NULL,
       applied_at = NULL,
       quarantined_at = GREATEST(
         pg_catalog.clock_timestamp(),
         received_at
       ),
       quarantine_reason = $6`,
      [reason],
    );
  }

  async replayQuarantined(
    key: PostgreSqlPassiveEventKey,
    signal?: AbortSignal,
  ): Promise<PostgreSqlPassiveEventRecord | null> {
    const machineId = uuidV7(key.machineId, this.projectId, "machine_id", key.eventId);
    const id = uuid(key.eventId, this.projectId, "event_id");
    return this.atomic("replayQuarantined", signal, async (transaction) => {
      const result = await transaction.query<PassiveEventRow>({
        text: `UPDATE lcm.passive_event_inbox
               SET status = 'pending',
                   next_attempt_at = GREATEST(
                     received_at,
                     pg_catalog.clock_timestamp()
                   ),
                   claimed_at = NULL,
                   claimed_by = NULL,
                   applied_at = NULL,
                   quarantined_at = NULL,
                   quarantine_reason = NULL
               WHERE project_id = $1
                 AND machine_id = $2
                 AND event_id = $3
                 AND status = 'quarantined'
               RETURNING *`,
        values: [this.projectId, machineId, id],
      }, this.options("replayQuarantined", signal));
      if (result.rows.length > 1) {
        return dataError(this.projectId, "replay_cardinality", id);
      }
      return result.rows[0]
        ? passiveEventFromRow(result.rows[0], this.projectId)
        : null;
    });
  }

  async listQuarantined(
    limit: number,
    signal?: AbortSignal,
  ): Promise<PostgreSqlPassiveEventRecord[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_BATCH_SIZE) {
      throw new Error(`quarantine limit must be an integer between 1 and ${MAX_BATCH_SIZE}`);
    }
    const result = await this.executor.query<PassiveEventRow>({
      text: `SELECT *
             FROM lcm.passive_event_inbox
             WHERE project_id = $1
               AND status = 'quarantined'
             ORDER BY quarantined_at, machine_id, machine_sequence, inbox_id
             LIMIT $2`,
      values: [this.projectId, limit],
    }, this.options("listQuarantined", signal));
    return result.rows.map((row) => passiveEventFromRow(row, this.projectId));
  }

  async pruneApplied(
    keys: readonly PostgreSqlPassiveEventPruneKey[],
    signal?: AbortSignal,
  ): Promise<bigint> {
    batchSize(keys.length);
    return this.atomic("pruneApplied", signal, async (transaction) => {
      let deleted = 0n;
      for (const key of keys) {
        const eventId = uuid(key.eventId, this.projectId, "event_id");
        const machineId = uuidV7(key.machineId, this.projectId, "machine_id", eventId);
        const inboxId = exactBigInt(
          key.inboxId,
          this.projectId,
          "inbox_id",
          1n,
          eventId,
        );
        const result = await transaction.query({
          text: `DELETE FROM lcm.passive_event_inbox
                 WHERE project_id = $1
                   AND inbox_id = $2::pg_catalog.int8
                   AND machine_id = $3
                   AND event_id = $4
                   AND status = 'applied'`,
          values: [this.projectId, inboxId.toString(), machineId, eventId],
        }, this.options("pruneApplied", signal));
        deleted += BigInt(result.rowCount ?? 0);
      }
      return deleted;
    });
  }

  private async claimTransition(
    operation: string,
    input: PostgreSqlPassiveEventClaimMutation,
    assignments: string,
    additionalValues: readonly unknown[],
  ): Promise<PostgreSqlPassiveEventRecord> {
    return this.atomic(operation, input.signal, async (transaction, scope) => {
      await this.assertFence(scope, input);
      const claim = await this.assertClaim(
        transaction,
        input.claim,
        operation,
        input.signal,
      );
      const result = await transaction.query<PassiveEventRow>({
        text: `UPDATE lcm.passive_event_inbox
               SET ${assignments}
               WHERE project_id = $1
                 AND inbox_id = $2::pg_catalog.int8
                 AND machine_id = $3
                 AND event_id = $4
                 AND status = 'claimed'
                 AND claimed_by = $5
               RETURNING *`,
        values: [
          this.projectId,
          claim.inboxId.toString(),
          claim.machineId,
          claim.eventId,
          claim.claimedBy,
          ...additionalValues,
        ],
      }, this.options(operation, input.signal));
      if (result.rows.length !== 1 || !result.rows[0]) {
        return dataError(this.projectId, "claimed_transition", claim.eventId);
      }
      return passiveEventFromRow(result.rows[0], this.projectId);
    });
  }

  private async assertClaim(
    transaction: PostgreSqlQueryExecutor,
    claim: PostgreSqlPassiveEventClaim,
    operation: string,
    signal?: AbortSignal,
  ): Promise<PostgreSqlPassiveEventClaim> {
    const expected = normalizedClaim(claim, this.projectId);
    const result = await transaction.query<PassiveEventRow>({
      text: `SELECT event.*
             FROM lcm.passive_event_inbox AS event
             WHERE event.project_id = $1
               AND event.inbox_id = $2::pg_catalog.int8
               AND event.machine_id = $3
               AND event.event_id = $4
               AND event.status = 'claimed'
               AND event.claimed_by = $5
             FOR UPDATE OF event`,
      values: [
        this.projectId,
        expected.inboxId.toString(),
        expected.machineId,
        expected.eventId,
        expected.claimedBy,
      ],
    }, this.options(operation, signal));
    if (result.rows.length !== 1 || !result.rows[0]) {
      return dataError(this.projectId, "claimed_row", expected.eventId);
    }
    const actual = claimFromRecord(
      passiveEventFromRow(result.rows[0], this.projectId),
      this.projectId,
    );
    assertSameClaim(expected, actual, this.projectId);
    return actual;
  }

  private assertFence(
    transaction: PostgreSqlTransactionScopeExecutor,
    input: PostgreSqlPassiveEventFence,
  ): Promise<unknown> {
    return new PostgreSqlWorkCoordinator(
      transaction,
      this.projectId,
      this.machineId,
    ).assertLeaseFence({
      resourceType: DRAIN_RESOURCE_TYPE,
      resourceKey: this.machineId,
      processId: input.processId,
      operation: DRAIN_OPERATION,
      fencingToken: input.fencingToken,
      signal: input.signal,
    });
  }

  private async readEventsWithExecutor(
    executor: PostgreSqlQueryExecutor,
    keys: readonly PostgreSqlPassiveEventKey[],
    operation: string,
    signal?: AbortSignal,
  ): Promise<PostgreSqlPassiveEventRecord[]> {
    batchSize(keys.length);
    const normalized = keys.map((key) => {
      const eventId = uuid(key.eventId, this.projectId, "event_id");
      return {
        eventId,
        machineId: uuidV7(key.machineId, this.projectId, "machine_id", eventId),
      };
    });
    const result = await executor.query<PassiveEventRow>({
      text: `SELECT event.*
             FROM lcm.passive_event_inbox AS event
             JOIN ROWS FROM (
               pg_catalog.unnest($2::pg_catalog.uuid[]),
               pg_catalog.unnest($3::pg_catalog.uuid[])
             ) WITH ORDINALITY AS requested(machine_id, event_id, ordinal)
               ON requested.machine_id = event.machine_id
              AND requested.event_id = event.event_id
             WHERE event.project_id = $1
             ORDER BY requested.ordinal`,
      values: [
        this.projectId,
        normalized.map(({ machineId }) => machineId),
        normalized.map(({ eventId }) => eventId),
      ],
    }, this.options(operation, signal));
    return result.rows.map((row) => passiveEventFromRow(row, this.projectId));
  }

  private context(
    operation: string,
    signal?: AbortSignal,
  ): PostgreSqlOperationContext & {
    readonly domain: "passive-events";
    readonly projectId: string;
    readonly machineId: string;
    readonly signal?: AbortSignal;
  } {
    return {
      domain: "passive-events",
      operation,
      projectId: this.projectId,
      machineId: this.machineId,
      ...(signal === undefined ? {} : { signal }),
    };
  }

  private options(operation: string, signal?: AbortSignal): PostgreSqlQueryOptions {
    return this.context(operation, signal);
  }

  private async atomic<T>(
    operation: string,
    signal: AbortSignal | undefined,
    callback: (
      executor: PostgreSqlQueryExecutor,
      transaction: PostgreSqlTransactionScopeExecutor,
    ) => Promise<T>,
  ): Promise<T> {
    if (
      "transaction" in this.executor
      && typeof this.executor.transaction === "function"
    ) {
      const transactional = this.executor as PostgreSqlCoordinationExecutor;
      return transactional.transaction(async (transaction) => {
        await transaction.query({
          text: "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
        }, this.options(operation, signal));
        return callback(transaction, transaction);
      }, {
        domain: "coordination",
        operation,
        projectId: this.projectId,
        machineId: this.machineId,
        ...(signal === undefined ? {} : { signal }),
      });
    }
    if (
      this.executor.transactionScope !== "active"
      || !("savepoint" in this.executor)
      || typeof this.executor.savepoint !== "function"
    ) {
      throw new StorageOperationError(
        "STORAGE_TRANSACTION_SCOPE",
        "postgresql",
        this.projectId,
        "passive-events",
        operation,
      );
    }
    return this.executor.savepoint(
      (savepoint) => callback(savepoint, this.executor as PostgreSqlTransactionScopeExecutor),
      this.options(operation, signal),
    );
  }
}
