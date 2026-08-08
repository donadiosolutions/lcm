import type {
  QueryConfig,
  QueryResult,
  QueryResultRow,
} from "pg";
import { StorageOperationError } from "../errors.js";
import type {
  PostgreSqlOperationContext,
  PostgreSqlQueryExecutor,
  PostgreSqlQueryOptions,
  PostgreSqlTransactionOptions,
  PostgreSqlTransactionScopeExecutor,
} from "./contracts.js";
import { PostgreSqlCommitOutcomeUnknownError } from "./errors.js";

export const POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_TYPE =
  "backend-publication" as const;
export const POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_KEY =
  "selection" as const;

const PUBLICATION_LOCK_SEPARATOR = "\u001f";
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PUBLICATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OPERATION_IDENTITY_PATTERN =
  /^backend-publication:(postgresql|sqlite):([0-9a-f]{64})$/u;
const DECIMAL_BIGINT_PATTERN = /^\d+$/u;
const MAX_PUBLICATION_TTL_MS = 24 * 60 * 60 * 1000;

type PublicationRow = QueryResultRow & {
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
  /** Expiry evaluated using the authoritative PostgreSQL clock. */
  readonly databaseExpired: boolean;
}

export interface PostgreSqlBackendPublicationAcquireInput {
  readonly projectId: string;
  readonly machineId: string;
  readonly publicationId: string;
  readonly targetBackend: PostgreSqlBackendPublicationTarget;
  readonly evidenceSha256: string;
  readonly ttlMs: number;
  /** Required to take over an expired unresolved generation. */
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

export interface PostgreSqlBackendPublicationControlExecutor {
  /** The only transaction capability that may take the exclusive publication lock. */
  projectPublicationTransaction<T>(
    projectId: string,
    callback: (transaction: PostgreSqlTransactionScopeExecutor) => Promise<T>,
    options: PostgreSqlTransactionOptions,
  ): Promise<T>;
  /** Readback deliberately bypasses normal shared admission after ambiguity. */
  projectPublicationReadback<
    R extends QueryResultRow = QueryResultRow,
    I extends unknown[] = unknown[],
  >(
    config: QueryConfig<I>,
    options: PostgreSqlQueryOptions,
  ): Promise<QueryResult<R>>;
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
  throw new PostgreSqlBackendPublicationGuardError(projectId, operation, reason);
}

function uuidV7(value: unknown, projectId: string, operation: string): string {
  if (typeof value !== "string" || !UUID_V7_PATTERN.test(value)) {
    return publicationError(projectId, operation, "invalid-input");
  }
  return value.toLowerCase();
}

function publicationId(
  value: unknown,
  projectId: string,
  operation: string,
): string {
  if (typeof value !== "string" || !PUBLICATION_ID_PATTERN.test(value)) {
    return publicationError(projectId, operation, "invalid-input");
  }
  return value;
}

function targetBackend(
  value: unknown,
  projectId: string,
  operation: string,
): PostgreSqlBackendPublicationTarget {
  if (value !== "postgresql" && value !== "sqlite") {
    return publicationError(projectId, operation, "invalid-input");
  }
  return value;
}

function evidenceSha256(
  value: unknown,
  projectId: string,
  operation: string,
): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    return publicationError(projectId, operation, "invalid-input");
  }
  return value;
}

function ttlMs(value: unknown, projectId: string, operation: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value <= 0
    || value > MAX_PUBLICATION_TTL_MS
  ) {
    return publicationError(projectId, operation, "invalid-input");
  }
  return value;
}

function fencingToken(
  value: unknown,
  projectId: string,
  operation: string,
): bigint {
  if (typeof value !== "bigint" || value <= 0n) {
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

function publicationLockName(projectId: string): string {
  return `${projectId}${PUBLICATION_LOCK_SEPARATOR}`
    + `${POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_TYPE}`
    + `${PUBLICATION_LOCK_SEPARATOR}${POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_KEY}`;
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

function selectLeaseSql(lock: boolean): string {
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

function timestamp(
  value: unknown,
  projectId: string,
  operation: string,
): string {
  const candidate = value instanceof Date
    ? new Date(value.getTime())
    : typeof value === "string"
      ? new Date(value)
      : new Date(Number.NaN);
  if (!Number.isFinite(candidate.getTime())) {
    return publicationError(projectId, operation, "invalid-row");
  }
  return candidate.toISOString();
}

function nullableTimestamp(
  value: unknown,
  projectId: string,
  operation: string,
): string | null {
  return value === null ? null : timestamp(value, projectId, operation);
}

function rowToken(value: unknown, projectId: string, operation: string): bigint {
  const candidate = typeof value === "bigint"
    ? value
    : typeof value === "string" && DECIMAL_BIGINT_PATTERN.test(value)
      ? BigInt(value)
      : -1n;
  return candidate > 0n
    ? candidate
    : publicationError(projectId, operation, "invalid-row");
}

function storedFenceFromRow(
  row: PublicationRow,
  projectId: string,
  operation: string,
): PostgreSqlBackendPublicationFence {
  const rowProjectId = typeof row.project_id === "string"
    ? row.project_id.toLowerCase()
    : "";
  const machineId = typeof row.owner_machine_id === "string"
    ? row.owner_machine_id.toLowerCase()
    : "";
  const publication = row.owner_process_id;
  const identity = typeof row.operation === "string"
    ? OPERATION_IDENTITY_PATTERN.exec(row.operation)
    : null;
  if (
    rowProjectId !== projectId
    || !UUID_V7_PATTERN.test(machineId)
    || typeof publication !== "string"
    || !PUBLICATION_ID_PATTERN.test(publication)
    || identity === null
    || (row.expired !== true && row.expired !== false)
  ) {
    return publicationError(projectId, operation, "invalid-row");
  }
  const acquiredAt = timestamp(row.acquired_at, projectId, operation);
  const renewedAt = timestamp(row.renewed_at, projectId, operation);
  const expiresAt = timestamp(row.expires_at, projectId, operation);
  const releasedAt = nullableTimestamp(row.released_at, projectId, operation);
  if (
    new Date(renewedAt).getTime() < new Date(acquiredAt).getTime()
    || new Date(expiresAt).getTime() <= new Date(renewedAt).getTime()
    || (releasedAt !== null
      && new Date(releasedAt).getTime() < new Date(renewedAt).getTime())
  ) {
    return publicationError(projectId, operation, "invalid-row");
  }
  return {
    projectId: rowProjectId,
    machineId,
    publicationId: publication,
    targetBackend: identity[1] as PostgreSqlBackendPublicationTarget,
    evidenceSha256: identity[2]!,
    fencingToken: rowToken(row.fencing_token, projectId, operation),
    acquiredAt,
    renewedAt,
    expiresAt,
    releasedAt,
    databaseExpired: row.expired,
  };
}

function exactFence(
  row: PublicationRow,
  expected: {
    readonly projectId: string;
    readonly machineId?: string;
    readonly publicationId?: string;
    readonly targetBackend: PostgreSqlBackendPublicationTarget;
    readonly evidenceSha256: string;
  },
  operation: string,
): PostgreSqlBackendPublicationFence {
  const fence = storedFenceFromRow(row, expected.projectId, operation);
  if (
    fence.targetBackend !== expected.targetBackend
    || fence.evidenceSha256 !== expected.evidenceSha256
    || (expected.machineId !== undefined && fence.machineId !== expected.machineId)
    || (expected.publicationId !== undefined
      && fence.publicationId !== expected.publicationId)
  ) {
    return publicationError(expected.projectId, operation, "invalid-row");
  }
  return fence;
}

function sameFence(
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

function mutationIdentity(
  input: PostgreSqlBackendPublicationMutationInput,
  operation: string,
): {
  readonly projectId: string;
  readonly machineId: string;
  readonly publicationId: string;
  readonly targetBackend: PostgreSqlBackendPublicationTarget;
  readonly evidenceSha256: string;
  readonly operationIdentity: string;
  readonly fencingToken: bigint;
} {
  const projectId = uuidV7(input.projectId, input.projectId, operation);
  const target = targetBackend(input.targetBackend, projectId, operation);
  const evidence = evidenceSha256(input.evidenceSha256, projectId, operation);
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

export async function acquirePostgreSqlProjectMutationGuard(
  executor: PostgreSqlQueryExecutor,
  projectIdInput: string,
  options: PostgreSqlQueryOptions,
): Promise<void> {
  const projectId = uuidV7(projectIdInput, projectIdInput, options.operation);
  const values = [
    publicationLockName(projectId),
  ];
  await executor.query({
    text: `SELECT pg_catalog.pg_advisory_xact_lock_shared(
                    pg_catalog.hashtextextended($1::pg_catalog.text, 0)
                  )`,
    values,
  }, options);
  const unresolved = await executor.query({
    text: `SELECT 1 AS unresolved
           FROM lcm.fenced_leases
           WHERE project_id = $1::pg_catalog.uuid
             AND resource_type = $2::pg_catalog.text
             AND resource_key = $3::pg_catalog.text
             AND released_at IS NULL`,
    values: leaseKeyValues(projectId),
  }, options);
  if (unresolved.rows.length > 1) {
    return publicationError(projectId, options.operation, "invalid-row");
  }
  if (unresolved.rows.length === 1) {
    return publicationError(
      projectId,
      options.operation,
      "publication-unresolved",
    );
  }
}

export async function acquirePostgreSqlProjectPublicationLock(
  executor: PostgreSqlQueryExecutor,
  projectIdInput: string,
  options: PostgreSqlQueryOptions,
): Promise<void> {
  const projectId = uuidV7(projectIdInput, projectIdInput, options.operation);
  await executor.query({
    text: `SELECT pg_catalog.pg_advisory_xact_lock(
                    pg_catalog.hashtextextended($1::pg_catalog.text, 0)
                  )`,
    values: [publicationLockName(projectId)],
  }, options);
}

export class PostgreSqlBackendPublicationGuard {
  constructor(private readonly executor: PostgreSqlBackendPublicationControlExecutor) {}

  async acquire(
    input: PostgreSqlBackendPublicationAcquireInput,
  ): Promise<PostgreSqlBackendPublicationFence> {
    const operation = "acquireBackendPublication";
    const normalized = this.acquireInput(input, operation);
    let candidate: PostgreSqlBackendPublicationFence | undefined;
    try {
      return await this.executor.projectPublicationTransaction(
        normalized.projectId,
        async (transaction) => {
          const existing = await transaction.query<PublicationRow>({
            text: selectLeaseSql(true),
            values: leaseKeyValues(normalized.projectId),
          }, context(normalized.projectId, operation, input.signal));
          if (existing.rows.length > 1) {
            return publicationError(normalized.projectId, operation, "invalid-row");
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
            const inserted = await transaction.query<PublicationRow>({
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
              return publicationError(normalized.projectId, operation, "invalid-row");
            }
            candidate = exactFence(inserted.rows[0]!, normalized, operation);
            return candidate;
          }

          const currentFence = storedFenceFromRow(
            current,
            normalized.projectId,
            operation,
          );
          const sameGeneration = currentFence.machineId === normalized.machineId
            && currentFence.publicationId === normalized.publicationId
            && currentFence.targetBackend === normalized.targetBackend
            && currentFence.evidenceSha256 === normalized.evidenceSha256;
          if (currentFence.releasedAt === null) {
            if (!sameGeneration) {
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
              candidate = currentFence;
              return currentFence;
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

          const replaced = await transaction.query<PublicationRow>({
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
          candidate = exactFence(replaced.rows[0]!, normalized, operation);
          return candidate;
        },
        {
          ...context(normalized.projectId, operation, input.signal),
          projectIds: [normalized.projectId],
          transactionMode: "read-committed-read-write",
        },
      );
    } catch (error) {
      if (!(error instanceof PostgreSqlCommitOutcomeUnknownError)) throw error;
      const observed = await this.read(normalized, operation);
      if (
        candidate !== undefined
        && observed !== null
        && sameFence(observed, candidate)
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
    const normalized = mutationIdentity(input, operation);
    const duration = ttlMs(input.ttlMs, normalized.projectId, operation);
    let candidate: PostgreSqlBackendPublicationFence | undefined;
    try {
      return await this.mutateExact(
        normalized,
        operation,
        input.signal,
        {
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
        },
        (fence) => { candidate = fence; },
      );
    } catch (error) {
      if (!(error instanceof PostgreSqlCommitOutcomeUnknownError)) throw error;
      const observed = await this.read(normalized, operation);
      if (
        candidate !== undefined
        && observed !== null
        && sameFence(observed, candidate)
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
    const normalized = mutationIdentity(input, operation);
    try {
      return await this.mutateExact(
        normalized,
        operation,
        input.signal,
        {
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
        },
      );
    } catch (error) {
      const uncertain = error instanceof PostgreSqlCommitOutcomeUnknownError;
      const exactMismatch = error instanceof PostgreSqlBackendPublicationGuardError
        && error.reason === "fence-mismatch";
      if (!uncertain && !exactMismatch) throw error;
      const observed = await this.read(normalized, operation);
      if (
        observed !== null
        && observed.releasedAt !== null
        && observed.machineId === normalized.machineId
        && observed.publicationId === normalized.publicationId
        && observed.fencingToken === normalized.fencingToken
      ) {
        return observed;
      }
      return publicationError(
        normalized.projectId,
        operation,
        uncertain ? "readback-mismatch" : "fence-mismatch",
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
    const evidence = evidenceSha256(input.evidenceSha256, projectId, operation);
    const result = await this.executor.projectPublicationReadback<PublicationRow>(
      {
        text: selectLeaseSql(false),
        values: leaseKeyValues(projectId),
      },
      context(projectId, operation, input.signal),
    );
    if (result.rows.length > 1) {
      return publicationError(projectId, operation, "invalid-row");
    }
    const row = result.rows[0];
    return row === undefined
      ? null
      : exactFence(row, {
        projectId,
        targetBackend: target,
        evidenceSha256: evidence,
      }, operation);
  }

  private async mutateExact(
    normalized: ReturnType<typeof mutationIdentity>,
    operation: string,
    signal: AbortSignal | undefined,
    query: { readonly text: string; readonly values: unknown[] },
    observeCandidate: (fence: PostgreSqlBackendPublicationFence) => void = () => undefined,
  ): Promise<PostgreSqlBackendPublicationFence> {
    return this.executor.projectPublicationTransaction(
      normalized.projectId,
      async (transaction) => {
        const result = await transaction.query<PublicationRow>(
          query,
          context(normalized.projectId, operation, signal),
        );
        if (result.rows.length !== 1) {
          return publicationError(
            normalized.projectId,
            operation,
            "fence-mismatch",
          );
        }
        const fence = exactFence(result.rows[0]!, normalized, operation);
        observeCandidate(fence);
        return fence;
      },
      {
        ...context(normalized.projectId, operation, signal),
        projectIds: [normalized.projectId],
        transactionMode: "read-committed-read-write",
      },
    );
  }

  private acquireInput(
    input: PostgreSqlBackendPublicationAcquireInput,
    operation: string,
  ): ReturnType<typeof mutationIdentity> & {
    readonly ttlMs: number;
    readonly expectedFencingToken?: bigint;
  } {
    const projectId = uuidV7(input.projectId, input.projectId, operation);
    const target = targetBackend(input.targetBackend, projectId, operation);
    const evidence = evidenceSha256(input.evidenceSha256, projectId, operation);
    return {
      projectId,
      machineId: uuidV7(input.machineId, projectId, operation),
      publicationId: publicationId(input.publicationId, projectId, operation),
      targetBackend: target,
      evidenceSha256: evidence,
      operationIdentity: operationIdentity(target, evidence),
      fencingToken: 1n,
      ttlMs: ttlMs(input.ttlMs, projectId, operation),
      expectedFencingToken: input.expectedFencingToken === undefined
        ? undefined
        : fencingToken(input.expectedFencingToken, projectId, operation),
    };
  }
}
