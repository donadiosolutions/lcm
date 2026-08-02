import type { QueryResultRow } from "pg";
import { StorageOperationError } from "../errors.js";
import type {
  PostgreSqlOperationContext,
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
  PostgreSqlTransactionScopeExecutor,
} from "./contracts.js";
import { PostgreSqlCommitOutcomeUnknownError } from "./errors.js";

export const POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_TYPE =
  "backend-publication" as const;
export const POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_KEY =
  "selection" as const;

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PUBLICATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OPERATION_IDENTITY_PATTERN =
  /^backend-publication:(postgresql|sqlite):([0-9a-f]{64})$/u;
const MAX_PUBLICATION_TTL_MS = 24 * 60 * 60 * 1000;

type LeaseRow = QueryResultRow & {
  project_id: unknown;
  owner_machine_id: unknown;
  owner_process_id: unknown;
  operation: unknown;
  fencing_token: unknown;
  acquired_at: unknown;
  renewed_at: unknown;
  expires_at: unknown;
  released_at: unknown;
  expired: unknown;
};

/**
 * Capability passed only by PostgreSqlRuntime.backendPublicationGuard().
 * It is deliberately absent from the public query-executor contract so a
 * normal repository cannot submit arbitrary SQL outside writer admission.
 */
export interface PostgreSqlBackendPublicationControlExecutor {
  projectPublicationTransaction<T>(
    projectId: string,
    callback: (transaction: PostgreSqlTransactionScopeExecutor) => Promise<T>,
    options: PostgreSqlOperationContext & { readonly signal?: AbortSignal },
  ): Promise<T>;

  projectPublicationReadback<
    R extends QueryResultRow = QueryResultRow,
    I extends unknown[] = unknown[],
  >(
    config: import("pg").QueryConfig<I>,
    options: PostgreSqlQueryOptions,
  ): Promise<import("pg").QueryResult<R>>;
}

export type PostgreSqlBackendPublicationTarget = "postgresql" | "sqlite";

export interface PostgreSqlBackendPublicationFence {
  readonly projectId: string;
  readonly machineId: string;
  readonly publicationId: string;
  readonly targetBackend: PostgreSqlBackendPublicationTarget;
  readonly evidenceSha256: string;
  readonly fencingToken: bigint;
  readonly acquiredAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
  readonly releasedAt: string | null;
  /** Authoritative database-clock state captured with this readback. */
  readonly databaseExpired: boolean;
}

export interface PostgreSqlBackendPublicationAcquireInput {
  readonly projectId: string;
  readonly machineId: string;
  readonly publicationId: string;
  readonly targetBackend: PostgreSqlBackendPublicationTarget;
  readonly evidenceSha256: string;
  readonly ttlMs: number;
  /** Required to renew an expired unresolved same-generation fence. */
  readonly expectedFencingToken?: bigint;
  readonly signal?: AbortSignal;
}

export interface PostgreSqlBackendPublicationMutationInput {
  readonly projectId: string;
  readonly machineId: string;
  readonly publicationId: string;
  readonly targetBackend: PostgreSqlBackendPublicationTarget;
  readonly evidenceSha256: string;
  readonly fencingToken: bigint;
  readonly signal?: AbortSignal;
}

export class PostgreSqlBackendPublicationGuardError
  extends StorageOperationError {
  constructor(
    projectId: string,
    operation: string,
    readonly reason:
      | "invalid-input"
      | "publication-conflict"
      | "publication-unresolved"
      | "fence-expired"
      | "fence-mismatch"
      | "readback-mismatch"
      | "invalid-row",
  ) {
    super(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      projectId,
      "coordination",
      operation,
    );
    this.name = "PostgreSqlBackendPublicationGuardError";
  }
}

function publicationError(
  projectId: string,
  operation: string,
  reason: PostgreSqlBackendPublicationGuardError["reason"],
): never {
  throw new PostgreSqlBackendPublicationGuardError(
    projectId,
    operation,
    reason,
  );
}

function uuidV7(value: string, projectId: string, operation: string): string {
  if (!UUID_V7_PATTERN.test(value)) {
    return publicationError(projectId, operation, "invalid-input");
  }
  return value.toLowerCase();
}

function publicationId(
  value: string,
  projectId: string,
  operation: string,
): string {
  if (!PUBLICATION_ID_PATTERN.test(value)) {
    return publicationError(projectId, operation, "invalid-input");
  }
  return value;
}

function evidenceSha256(
  value: string,
  projectId: string,
  operation: string,
): string {
  if (!SHA256_PATTERN.test(value)) {
    return publicationError(projectId, operation, "invalid-input");
  }
  return value;
}

function ttlMs(value: number, projectId: string, operation: string): number {
  if (
    !Number.isSafeInteger(value)
    || value <= 0
    || value > MAX_PUBLICATION_TTL_MS
  ) {
    return publicationError(projectId, operation, "invalid-input");
  }
  return value;
}

function fencingToken(
  value: bigint,
  projectId: string,
  operation: string,
): bigint {
  if (typeof value !== "bigint" || value <= 0n) {
    return publicationError(projectId, operation, "invalid-input");
  }
  return value;
}

function targetBackend(
  value: PostgreSqlBackendPublicationTarget,
  projectId: string,
  operation: string,
): PostgreSqlBackendPublicationTarget {
  if (value !== "postgresql" && value !== "sqlite") {
    return publicationError(projectId, operation, "invalid-input");
  }
  return value;
}

function operationIdentity(
  target: PostgreSqlBackendPublicationTarget,
  evidence: string,
): string {
  return `backend-publication:${target}:${evidence}`;
}

function lockName(projectId: string): string {
  return `${projectId}\u001f${POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_TYPE}\u001f${POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_KEY}`;
}

function timestamp(
  value: unknown,
  projectId: string,
  operation: string,
): string {
  const date = value instanceof Date
    ? value
    : typeof value === "string"
      ? new Date(value)
      : null;
  if (date === null || !Number.isFinite(date.getTime())) {
    return publicationError(projectId, operation, "invalid-row");
  }
  return date.toISOString();
}

function optionalTimestamp(
  value: unknown,
  projectId: string,
  operation: string,
): string | null {
  return value === null ? null : timestamp(value, projectId, operation);
}

function bigintRow(
  value: unknown,
  projectId: string,
  operation: string,
): bigint {
  const parsed = typeof value === "bigint"
    ? value
    : typeof value === "string" && /^\d+$/u.test(value)
      ? BigInt(value)
      : -1n;
  if (parsed <= 0n) return publicationError(projectId, operation, "invalid-row");
  return parsed;
}

function fenceFromRow(
  row: LeaseRow,
  expected: {
    readonly projectId: string;
    readonly operation: string;
    readonly targetBackend: PostgreSqlBackendPublicationTarget;
    readonly evidenceSha256: string;
  },
): PostgreSqlBackendPublicationFence {
  const fence = storedFenceFromRow(row, expected.projectId, expected.operation);
  if (
    fence.targetBackend !== expected.targetBackend
    || fence.evidenceSha256 !== expected.evidenceSha256
  ) {
    return publicationError(
      expected.projectId,
      expected.operation,
      "invalid-row",
    );
  }
  return fence;
}

function storedFenceFromRow(
  row: LeaseRow,
  expectedProjectId: string,
  operation: string,
): PostgreSqlBackendPublicationFence {
  const projectIdValue = typeof row.project_id === "string"
    ? row.project_id.toLowerCase()
    : "";
  const machineIdValue = typeof row.owner_machine_id === "string"
    ? row.owner_machine_id.toLowerCase()
    : "";
  const publicationIdValue = typeof row.owner_process_id === "string"
    ? row.owner_process_id
    : "";
  const operationIdentityMatch = typeof row.operation === "string"
    ? OPERATION_IDENTITY_PATTERN.exec(row.operation)
    : null;
  if (
    projectIdValue !== expectedProjectId
    || !UUID_V7_PATTERN.test(machineIdValue)
    || !PUBLICATION_ID_PATTERN.test(publicationIdValue)
    || operationIdentityMatch === null
  ) {
    return publicationError(
      expectedProjectId,
      operation,
      "invalid-row",
    );
  }
  if (row.expired !== true && row.expired !== false) {
    return publicationError(
      expectedProjectId,
      operation,
      "invalid-row",
    );
  }
  return {
    projectId: projectIdValue,
    machineId: machineIdValue,
    publicationId: publicationIdValue,
    targetBackend: operationIdentityMatch[1] as PostgreSqlBackendPublicationTarget,
    evidenceSha256: operationIdentityMatch[2]!,
    fencingToken: bigintRow(
      row.fencing_token,
      expectedProjectId,
      operation,
    ),
    acquiredAt: timestamp(
      row.acquired_at,
      expectedProjectId,
      operation,
    ),
    renewedAt: timestamp(
      row.renewed_at,
      expectedProjectId,
      operation,
    ),
    expiresAt: timestamp(
      row.expires_at,
      expectedProjectId,
      operation,
    ),
    releasedAt: optionalTimestamp(
      row.released_at,
      expectedProjectId,
      operation,
    ),
    databaseExpired: row.expired,
  };
}

function sameFenceMutation(
  observed: PostgreSqlBackendPublicationFence,
  candidate: PostgreSqlBackendPublicationFence,
): boolean {
  return observed.projectId === candidate.projectId
    && observed.machineId === candidate.machineId
    && observed.publicationId === candidate.publicationId
    && observed.targetBackend === candidate.targetBackend
    && observed.evidenceSha256 === candidate.evidenceSha256
    && observed.fencingToken === candidate.fencingToken
    && observed.acquiredAt === candidate.acquiredAt
    && observed.renewedAt === candidate.renewedAt
    && observed.expiresAt === candidate.expiresAt
    && observed.releasedAt === candidate.releasedAt;
}

function context(
  projectId: string,
  operation: string,
  signal?: AbortSignal,
): PostgreSqlQueryOptions {
  return {
    domain: "coordination",
    operation,
    projectId,
    ...(signal === undefined ? {} : { signal }),
  };
}

/**
 * Lock order shared by every normal runtime transaction:
 * advisory project-publication lock, then the reserved fenced-lease row.
 */
export async function acquirePostgreSqlProjectMutationGuard(
  executor: PostgreSqlQueryExecutor,
  projectIdInput: string,
  options: PostgreSqlQueryOptions,
): Promise<void> {
  const projectId = uuidV7(
    projectIdInput,
    projectIdInput,
    options.operation,
  );
  await executor.query({
    text: `SELECT pg_catalog.pg_advisory_xact_lock_shared(
                    pg_catalog.hashtextextended($1::pg_catalog.text, 0)
                  )`,
    values: [lockName(projectId)],
  }, options);
  const unresolved = await executor.query({
    text: `SELECT 1 AS unresolved
           FROM lcm.fenced_leases
           WHERE project_id = $1::pg_catalog.uuid
             AND resource_type = $2::pg_catalog.text
             AND resource_key = $3::pg_catalog.text
             AND released_at IS NULL`,
    values: [
      projectId,
      POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_TYPE,
      POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_KEY,
    ],
  }, options);
  if (unresolved.rows.length > 1) {
    return publicationError(projectId, options.operation, "invalid-row");
  }
  // Expiry deliberately does not make an unresolved publication safe. The
  // durable row remains a fail-closed recovery obligation after process loss.
  if (unresolved.rows.length === 1) {
    return publicationError(
      projectId,
      options.operation,
      "publication-unresolved",
    );
  }
}

/** Acquire the exclusive half of the same stable per-project lock order. */
export async function acquirePostgreSqlProjectPublicationLock(
  executor: PostgreSqlQueryExecutor,
  projectIdInput: string,
  options: PostgreSqlQueryOptions,
): Promise<void> {
  const projectId = uuidV7(
    projectIdInput,
    projectIdInput,
    options.operation,
  );
  await executor.query({
    text: `SELECT pg_catalog.pg_advisory_xact_lock(
                    pg_catalog.hashtextextended($1::pg_catalog.text, 0)
                  )`,
    values: [lockName(projectId)],
  }, options);
}

function selectLeaseSql(lock = false): string {
  return `SELECT project_id, owner_machine_id, owner_process_id, operation,
                 fencing_token, acquired_at, renewed_at, expires_at,
                 released_at,
                 expires_at <= pg_catalog.statement_timestamp() AS expired
          FROM lcm.fenced_leases
          WHERE project_id = $1::pg_catalog.uuid
            AND resource_type = $2::pg_catalog.text
            AND resource_key = $3::pg_catalog.text${lock ? "\n          FOR UPDATE" : ""}`;
}

function leaseKeyValues(projectId: string): string[] {
  return [
    projectId,
    POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_TYPE,
    POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_KEY,
  ];
}

/** Common remote guard consumed by reversible migration and backend routing. */
export class PostgreSqlBackendPublicationGuard {
  constructor(
    private readonly executor: PostgreSqlBackendPublicationControlExecutor,
  ) {}

  async acquire(
    input: PostgreSqlBackendPublicationAcquireInput,
  ): Promise<PostgreSqlBackendPublicationFence> {
    const operation = "acquireBackendPublication";
    const normalized = this.acquireInput(input, operation);
    let candidate: PostgreSqlBackendPublicationFence | undefined;
    const remember = (
      fence: PostgreSqlBackendPublicationFence,
    ): PostgreSqlBackendPublicationFence => {
      candidate = fence;
      return fence;
    };
    try {
      return await this.executor.projectPublicationTransaction(
        normalized.projectId,
        async (transaction) => {
          const existing = await transaction.query<LeaseRow>({
            text: selectLeaseSql(true),
            values: leaseKeyValues(normalized.projectId),
          }, context(normalized.projectId, operation, input.signal));
          if (existing.rows.length > 1) {
            return publicationError(
              normalized.projectId,
              operation,
              "invalid-row",
            );
          }
          const current = existing.rows[0];
          if (current === undefined) {
            if (normalized.expectedFencingToken !== undefined) {
              return publicationError(
                normalized.projectId,
                operation,
                "fence-mismatch",
              );
            }
            const inserted = await transaction.query<LeaseRow>({
              text: `INSERT INTO lcm.fenced_leases (
                       project_id, resource_type, resource_key,
                       owner_machine_id, owner_process_id, operation,
                       expires_at
                     )
                     VALUES (
                       $1::pg_catalog.uuid, $2::pg_catalog.text,
                       $3::pg_catalog.text, $4::pg_catalog.uuid,
                       $5::pg_catalog.text, $6::pg_catalog.text,
                       pg_catalog.statement_timestamp()
                         + $7::pg_catalog.float8 * interval '1 millisecond'
                     )
                     RETURNING project_id, owner_machine_id,
                               owner_process_id, operation, fencing_token,
                               acquired_at, renewed_at, expires_at, released_at,
                               false AS expired`,
              values: [
                ...leaseKeyValues(normalized.projectId),
                normalized.machineId,
                normalized.publicationId,
                normalized.operationIdentity,
                normalized.ttlMs,
              ],
            }, context(normalized.projectId, operation, input.signal));
            if (inserted.rows.length !== 1) {
              return publicationError(
                normalized.projectId,
                operation,
                "invalid-row",
              );
            }
            return remember(this.fence(
              inserted.rows[0]!,
              normalized,
              operation,
            ));
          }

          const currentFence = storedFenceFromRow(
            current,
            normalized.projectId,
            operation,
          );
          if (currentFence.releasedAt === null) {
            if (
              currentFence.machineId !== normalized.machineId
              || currentFence.publicationId !== normalized.publicationId
              || currentFence.targetBackend !== normalized.targetBackend
              || currentFence.evidenceSha256 !== normalized.evidenceSha256
            ) {
              return publicationError(
                normalized.projectId,
                operation,
                "publication-conflict",
              );
            }
            if (
              normalized.expectedFencingToken !== undefined
              && currentFence.fencingToken !== normalized.expectedFencingToken
            ) {
              return publicationError(
                normalized.projectId,
                operation,
                "fence-mismatch",
              );
            }
            if (!currentFence.databaseExpired) {
              return remember(currentFence);
            }
            if (normalized.expectedFencingToken === undefined) {
              return publicationError(
                normalized.projectId,
                operation,
                "fence-expired",
              );
            }
          } else if (normalized.expectedFencingToken !== undefined) {
            return publicationError(
              normalized.projectId,
              operation,
              "fence-mismatch",
            );
          }

          const replaced = await transaction.query<LeaseRow>({
            text: `UPDATE lcm.fenced_leases
                   SET owner_machine_id = $4::pg_catalog.uuid,
                       owner_process_id = $5::pg_catalog.text,
                       operation = $6::pg_catalog.text,
                       fencing_token = DEFAULT,
                       acquired_at = pg_catalog.statement_timestamp(),
                       renewed_at = pg_catalog.statement_timestamp(),
                       expires_at = pg_catalog.statement_timestamp()
                         + $7::pg_catalog.float8 * interval '1 millisecond',
                       released_at = NULL
                   WHERE project_id = $1::pg_catalog.uuid
                     AND resource_type = $2::pg_catalog.text
                     AND resource_key = $3::pg_catalog.text
                     AND fencing_token = $8::pg_catalog.int8
                   RETURNING project_id, owner_machine_id,
                             owner_process_id, operation, fencing_token,
                             acquired_at, renewed_at, expires_at, released_at,
                             false AS expired`,
            values: [
              ...leaseKeyValues(normalized.projectId),
              normalized.machineId,
              normalized.publicationId,
              normalized.operationIdentity,
              normalized.ttlMs,
              currentFence.fencingToken.toString(),
            ],
          }, context(normalized.projectId, operation, input.signal));
          if (replaced.rows.length !== 1) {
            return publicationError(
              normalized.projectId,
              operation,
              "fence-mismatch",
            );
          }
          return remember(this.fence(
            replaced.rows[0]!,
            normalized,
            operation,
          ));
        },
        context(normalized.projectId, operation, input.signal),
      );
    } catch (error) {
      if (!(error instanceof PostgreSqlCommitOutcomeUnknownError)) throw error;
      const observed = await this.read(normalized, operation);
      if (
        candidate !== undefined
        && observed !== null
        && sameFenceMutation(observed, candidate)
        && observed.releasedAt === null
        && !observed.databaseExpired
      ) {
        return observed;
      }
      return publicationError(
        normalized.projectId,
        operation,
        "readback-mismatch",
      );
    }
  }

  async renew(
    input: PostgreSqlBackendPublicationMutationInput & { readonly ttlMs: number },
  ): Promise<PostgreSqlBackendPublicationFence> {
    const operation = "renewBackendPublication";
    const normalized = this.mutationInput(input, operation);
    const duration = ttlMs(input.ttlMs, normalized.projectId, operation);
    let candidate: PostgreSqlBackendPublicationFence | undefined;
    try {
      return await this.mutateExact(normalized, operation, input.signal, {
        text: `UPDATE lcm.fenced_leases
             SET renewed_at = pg_catalog.statement_timestamp(),
                 expires_at = pg_catalog.statement_timestamp()
                   + $8::pg_catalog.float8 * interval '1 millisecond'
             WHERE project_id = $1::pg_catalog.uuid
               AND resource_type = $2::pg_catalog.text
               AND resource_key = $3::pg_catalog.text
               AND owner_machine_id = $4::pg_catalog.uuid
               AND owner_process_id = $5::pg_catalog.text
               AND operation = $6::pg_catalog.text
               AND fencing_token = $7::pg_catalog.int8
               AND released_at IS NULL
               AND expires_at > pg_catalog.statement_timestamp()
             RETURNING project_id, owner_machine_id, owner_process_id,
                       operation, fencing_token, acquired_at, renewed_at,
                       expires_at, released_at, false AS expired`,
        values: [
          ...leaseKeyValues(normalized.projectId),
          normalized.machineId,
          normalized.publicationId,
          normalized.operationIdentity,
          normalized.fencingToken.toString(),
          duration,
        ],
      }, (fence) => { candidate = fence; });
    } catch (error) {
      if (!(error instanceof PostgreSqlCommitOutcomeUnknownError)) throw error;
      const observed = await this.read(normalized, operation);
      if (
        candidate !== undefined
        && observed !== null
        && sameFenceMutation(observed, candidate)
        && observed.releasedAt === null
        && !observed.databaseExpired
      ) {
        return observed;
      }
      return publicationError(
        normalized.projectId,
        operation,
        "readback-mismatch",
      );
    }
  }

  async release(
    input: PostgreSqlBackendPublicationMutationInput,
  ): Promise<PostgreSqlBackendPublicationFence> {
    const operation = "releaseBackendPublication";
    const normalized = this.mutationInput(input, operation);
    try {
      return await this.mutateExact(normalized, operation, input.signal, {
        text: `UPDATE lcm.fenced_leases
               SET released_at = GREATEST(
                     pg_catalog.statement_timestamp(), renewed_at
                   )
               WHERE project_id = $1::pg_catalog.uuid
                 AND resource_type = $2::pg_catalog.text
                 AND resource_key = $3::pg_catalog.text
                 AND owner_machine_id = $4::pg_catalog.uuid
                 AND owner_process_id = $5::pg_catalog.text
                 AND operation = $6::pg_catalog.text
                 AND fencing_token = $7::pg_catalog.int8
                 AND released_at IS NULL
                 AND expires_at > pg_catalog.statement_timestamp()
               RETURNING project_id, owner_machine_id, owner_process_id,
                         operation, fencing_token, acquired_at, renewed_at,
                         expires_at, released_at, false AS expired`,
        values: [
          ...leaseKeyValues(normalized.projectId),
          normalized.machineId,
          normalized.publicationId,
          normalized.operationIdentity,
          normalized.fencingToken.toString(),
        ],
      });
    } catch (error) {
      const outcomeUnknown = error instanceof PostgreSqlCommitOutcomeUnknownError;
      const exactMismatch =
        error instanceof PostgreSqlBackendPublicationGuardError
        && error.reason === "fence-mismatch";
      if (!outcomeUnknown && !exactMismatch) {
        throw error;
      }
      const observed = await this.read(normalized, operation);
      if (
        observed?.releasedAt !== null
        && observed?.fencingToken === normalized.fencingToken
        && observed.machineId === normalized.machineId
        && observed.publicationId === normalized.publicationId
      ) {
        return observed;
      }
      return publicationError(
        normalized.projectId,
        operation,
        outcomeUnknown ? "readback-mismatch" : "fence-mismatch",
      );
    }
  }

  async read(
    input: Pick<
      PostgreSqlBackendPublicationMutationInput,
      "projectId" | "targetBackend" | "evidenceSha256" | "signal"
    >,
    operation = "readBackendPublication",
  ): Promise<PostgreSqlBackendPublicationFence | null> {
    const projectId = uuidV7(input.projectId, input.projectId, operation);
    const target = targetBackend(input.targetBackend, projectId, operation);
    const evidence = evidenceSha256(
      input.evidenceSha256,
      projectId,
      operation,
    );
    const result = await this.executor.projectPublicationReadback<LeaseRow>({
      text: selectLeaseSql(false),
      values: leaseKeyValues(projectId),
    }, context(projectId, operation, input.signal));
    if (result.rows.length > 1) {
      return publicationError(projectId, operation, "invalid-row");
    }
    const row = result.rows[0];
    return row === undefined
      ? null
      : fenceFromRow(row, {
        projectId,
        operation,
        targetBackend: target,
        evidenceSha256: evidence,
      });
  }

  private async mutateExact(
    normalized: ReturnType<PostgreSqlBackendPublicationGuard["mutationInput"]>,
    operation: string,
    signal: AbortSignal | undefined,
    query: { readonly text: string; readonly values: unknown[] },
    observeCandidate: (fence: PostgreSqlBackendPublicationFence) => void = () => undefined,
  ): Promise<PostgreSqlBackendPublicationFence> {
    return this.executor.projectPublicationTransaction(
      normalized.projectId,
      async (transaction) => {
        const result = await transaction.query<LeaseRow>(query, context(
          normalized.projectId,
          operation,
          signal,
        ));
        if (result.rows.length !== 1) {
          return publicationError(
            normalized.projectId,
            operation,
            "fence-mismatch",
          );
        }
        const fence = this.fence(result.rows[0]!, normalized, operation);
        observeCandidate(fence);
        return fence;
      },
      context(normalized.projectId, operation, signal),
    );
  }

  private acquireInput(
    input: PostgreSqlBackendPublicationAcquireInput,
    operation: string,
  ) {
    const projectId = uuidV7(input.projectId, input.projectId, operation);
    const target = targetBackend(input.targetBackend, projectId, operation);
    const evidence = evidenceSha256(
      input.evidenceSha256,
      projectId,
      operation,
    );
    return {
      projectId,
      machineId: uuidV7(input.machineId, projectId, operation),
      publicationId: publicationId(input.publicationId, projectId, operation),
      targetBackend: target,
      evidenceSha256: evidence,
      operationIdentity: operationIdentity(target, evidence),
      ttlMs: ttlMs(input.ttlMs, projectId, operation),
      expectedFencingToken: input.expectedFencingToken === undefined
        ? undefined
        : fencingToken(input.expectedFencingToken, projectId, operation),
    };
  }

  private mutationInput(
    input: PostgreSqlBackendPublicationMutationInput,
    operation: string,
  ) {
    const projectId = uuidV7(input.projectId, input.projectId, operation);
    const target = targetBackend(input.targetBackend, projectId, operation);
    const evidence = evidenceSha256(
      input.evidenceSha256,
      projectId,
      operation,
    );
    return {
      projectId,
      machineId: uuidV7(input.machineId, projectId, operation),
      publicationId: publicationId(input.publicationId, projectId, operation),
      targetBackend: target,
      evidenceSha256: evidence,
      operationIdentity: operationIdentity(target, evidence),
      fencingToken: fencingToken(input.fencingToken, projectId, operation),
    };
  }

  private fence(
    row: LeaseRow,
    expected: {
      readonly projectId: string;
      readonly targetBackend: PostgreSqlBackendPublicationTarget;
      readonly evidenceSha256: string;
    },
    operation: string,
  ): PostgreSqlBackendPublicationFence {
    return fenceFromRow(row, { ...expected, operation });
  }
}
