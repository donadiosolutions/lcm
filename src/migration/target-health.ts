import { StorageOperationError } from "../storage/errors.js";
import type { PostgreSqlQueryExecutor, PostgreSqlRuntimeHealth } from "../storage/postgresql/contracts.js";
import { PostgreSqlCommitOutcomeUnknownError, PostgreSqlStorageOperationError } from "../storage/postgresql/errors.js";
import {
  PostgreSqlRuntimeReadinessError,
  verifyPostgreSqlRuntimeSchema,
  type PostgreSqlRuntimeReadiness,
} from "../storage/postgresql/runtime-readiness.js";

/**
 * Three-valued health of the PostgreSQL target a migration is about to
 * activate onto (plan-v5 S6 and S15; plan-v6 G7). The observation is the
 * same pair the PostgreSQL storage factory itself performs before it will
 * serve anything (createPostgreSqlStorageBackendFactoryWithHome in
 * ../storage/postgresql/factory.ts): an authenticated runtime health probe,
 * then verifyPostgreSqlRuntimeSchema against the configured migration role.
 * The factory collapses every failure into one opaque initialization error;
 * this module deliberately does not, because the activation driver must
 * tell two very different situations apart:
 *
 * - "unhealthy": the server answered, and the answer is a definite refusal
 *   or a definite mismatch -- authentication rejected (SQLSTATE class 28),
 *   insufficient privilege (42501), any other definite SQLSTATE the server
 *   returned for the probe, a preflight fact the health probe observed on a
 *   live connection (wrong major version, encoding, TLS, time zone,
 *   extensions or search configuration), or a readiness mismatch the schema
 *   check positively established (ownership, ledger, fingerprint, ACL shape,
 *   effective privilege, role policy, extension / search / collation
 *   preflight). The target is not fit to activate onto, and retrying
 *   without an operator changing something will not help.
 * - "unresolvable": the check could not look. A transport failure, a
 *   connection-class or operator-intervention SQLSTATE (08xxx, 57xxx,
 *   53xxx, 40xxx, 25P03, XXxxx), a retryable driver error, an already-closed
 *   or degraded runtime, an abort, or an error shape this module does not
 *   recognize. Nothing was learned about the target's fitness.
 *
 * Collapsing the two would either block a correct activation forever
 * (unresolvable folded into unhealthy) or let a genuinely refused target
 * pass as merely "not yet reachable" (unhealthy folded into unresolvable).
 * The attribution rides on the result as reason, detail and the sanitized
 * SQLSTATE; this module never discards it and never throws for a target
 * condition. The only throw is a MigrationTargetHealthError for a caller
 * programming error (malformed input, or an expected owner the readiness
 * check itself refuses as a role name before looking at the server).
 *
 * One ambiguity is inherited from runtime-readiness.ts and documented here
 * so nobody collapses it: verifyPostgreSqlSchema wraps every error it does
 * not recognize -- including a transport failure that happens mid-check,
 * after the health probe already succeeded -- into
 * PostgreSqlRuntimeReadinessError with reason "server-preflight", the same
 * reason inspectServerReadiness uses for a definite server-setting
 * mismatch. That single reason therefore cannot be attributed from the
 * outside, and this module reports it as unresolvable
 * ("schema-check-indeterminate") rather than guess. Every other readiness
 * reason is produced only after a query succeeded and a comparison ran, so
 * it is a definite "schema-mismatch".
 */

export type MigrationTargetHealthStatus = "healthy" | "unhealthy" | "unresolvable";

export type MigrationTargetUnhealthyReason =
  /** The server rejected the credentials (SQLSTATE class 28). */
  | "authentication-refused"
  /** The role connected but lacks a privilege the probe needs (42501). */
  | "insufficient-privilege"
  /** The server answered the probe with another definite, non-transport SQLSTATE. */
  | "server-refused"
  /** The health probe connected and observed a disqualifying server fact
   * (major version, encoding, TLS, time zone, extensions, search configuration). */
  | "server-preflight"
  /** verifyPostgreSqlRuntimeSchema positively established a mismatch (see
   * the readiness reason carried in detail). */
  | "schema-mismatch";

export type MigrationTargetUnresolvableReason =
  /** The caller's AbortSignal was already aborted; nothing was observed. */
  | "aborted"
  /** The runtime handed in reports itself closed. */
  | "runtime-closed"
  /** The pool reported an asynchronous failure earlier; the probe cannot
   * vouch for the connection it ran on. */
  | "pool-degraded"
  /** Transport failure, connection-class SQLSTATE, or a retryable driver
   * error: the server was never reached, or was lost before answering. */
  | "connection-failed"
  /** The readiness check reported "server-preflight", which folds a
   * mid-check transport failure and a definite setting mismatch into one
   * reason (see the module doc comment). */
  | "schema-check-indeterminate"
  /** An error shape this module does not recognize. */
  | "unknown";

/** Attributed three-valued result. Never collapse to a boolean. */
export type MigrationTargetHealthResult = Readonly<
  | { status: "healthy"; readiness: PostgreSqlRuntimeReadiness }
  | { status: "unhealthy"; reason: MigrationTargetUnhealthyReason; detail: string; sqlState: string | null }
  | { status: "unresolvable"; reason: MigrationTargetUnresolvableReason; detail: string; sqlState: string | null }
>;

/** The subset of PostgreSqlRuntime this check consumes: the authenticated
 * health probe and the query executor verifyPostgreSqlRuntimeSchema runs
 * its catalog inspection through. A real PostgreSqlRuntime satisfies it;
 * tests inject fakes. */
export type MigrationTargetHealthRuntime = PostgreSqlQueryExecutor & Readonly<{
  health(signal?: AbortSignal): Promise<PostgreSqlRuntimeHealth>;
}>;

export type MigrationTargetHealthInput = Readonly<{
  runtime: MigrationTargetHealthRuntime;
  /** The configured migration role the schema is expected to be owned by
   * (config.postgresql.migrationRole, exactly what the factory passes). */
  expectedOwner: string;
  signal?: AbortSignal;
}>;

export type MigrationTargetHealthDependencies = Readonly<{
  /** Defaults to verifyPostgreSqlRuntimeSchema, the factory's own check. */
  verifyRuntimeSchema?: typeof verifyPostgreSqlRuntimeSchema;
}>;

export type MigrationTargetHealthErrorReason = "invalid-input";

/** Caller programming error, thrown before (or instead of) any target
 * observation. Never used for a condition of the target itself. */
export class MigrationTargetHealthError extends Error {
  constructor(readonly reason: MigrationTargetHealthErrorReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MigrationTargetHealthError";
  }
}

type Attributed = Exclude<MigrationTargetHealthResult, { status: "healthy" }>;

/** SQLSTATE classes whose presence means the server was lost, never
 * reached, or asked the client to retry, rather than a definite answer
 * about this role's fitness: 08 connection exception, 57 operator
 * intervention (incl. 57014 cancelled, 57P01-03 shutdown), 53 insufficient
 * resources, 40 transaction rollback, XX internal error. 25P03 is the
 * idle-in-transaction kill errors.ts keeps separate for the same reason. */
const INDETERMINATE_SQLSTATE_CLASSES: ReadonlySet<string> = new Set(["08", "57", "53", "40", "XX"]);
const IDLE_KILL_SQLSTATE = "25P03";
const AUTHENTICATION_SQLSTATE_CLASS = "28";
const INSUFFICIENT_PRIVILEGE_SQLSTATE = "42501";

function unresolvable(
  reason: MigrationTargetUnresolvableReason,
  detail: string,
  sqlState: string | null = null,
): Attributed {
  return { status: "unresolvable", reason, detail, sqlState };
}

function unhealthy(
  reason: MigrationTargetUnhealthyReason,
  detail: string,
  sqlState: string | null = null,
): Attributed {
  return { status: "unhealthy", reason, detail, sqlState };
}

function classifySqlState(error: PostgreSqlStorageOperationError, stage: string): Attributed {
  const sqlState = error.sqlState;
  if (sqlState === null) {
    return error.retryable
      ? unresolvable("connection-failed", stage + " failed with a retryable driver error and no SQLSTATE")
      : unresolvable("unknown", stage + " failed with code " + error.code + " and no SQLSTATE");
  }
  const sqlStateClass = sqlState.slice(0, 2);
  if (error.retryable || sqlState === IDLE_KILL_SQLSTATE || INDETERMINATE_SQLSTATE_CLASSES.has(sqlStateClass)) {
    return unresolvable("connection-failed", stage + " was lost or refused transport with SQLSTATE " + sqlState, sqlState);
  }
  if (sqlStateClass === AUTHENTICATION_SQLSTATE_CLASS) {
    return unhealthy("authentication-refused", stage + ": the server rejected authentication with SQLSTATE " + sqlState, sqlState);
  }
  if (sqlState === INSUFFICIENT_PRIVILEGE_SQLSTATE) {
    return unhealthy("insufficient-privilege", stage + ": the server refused the role's privilege with SQLSTATE " + sqlState, sqlState);
  }
  return unhealthy("server-refused", stage + ": the server answered with a definite SQLSTATE " + sqlState, sqlState);
}

function classifyReadiness(error: PostgreSqlRuntimeReadinessError, stage: string): Attributed {
  if (error.reason === "invalid-expected-owner") {
    throw new MigrationTargetHealthError(
      "invalid-input",
      "migration target health expectedOwner is not an acceptable role name",
      { cause: error },
    );
  }
  if (error.reason === "server-preflight") {
    return unresolvable(
      "schema-check-indeterminate",
      stage + ": readiness reported server-preflight, which folds a mid-check transport failure and a definite" +
        " server-setting mismatch into one reason and cannot be attributed from outside runtime-readiness.ts",
    );
  }
  return unhealthy("schema-mismatch", stage + ": readiness established a definite mismatch (" + error.reason + ")");
}

/**
 * Attribute one failure observed at one stage. Only recognized shapes are
 * attributed definitely; anything else is "unresolvable: unknown" with the
 * error's constructor name (never its message, which for a raw driver
 * error can carry connection details).
 */
function classifyFailure(error: unknown, stage: string): Attributed {
  if (error instanceof PostgreSqlRuntimeReadinessError) return classifyReadiness(error, stage);
  if (error instanceof PostgreSqlCommitOutcomeUnknownError) {
    return unresolvable("connection-failed", stage + " lost its connection with the outcome unknown");
  }
  if (error instanceof PostgreSqlStorageOperationError) return classifySqlState(error, stage);
  if (error instanceof StorageOperationError) {
    if (error.code === "STORAGE_CLOSED") {
      return unresolvable("runtime-closed", stage + ": the runtime reported itself closed");
    }
    return unhealthy(
      "server-preflight",
      stage + ": the probe connected and observed a disqualifying server fact (" + error.name + ", operation " +
        error.operation + ")",
    );
  }
  const name = error instanceof Error ? error.name : typeof error;
  return unresolvable("unknown", stage + " failed with an unrecognized error (" + name + ")");
}

/**
 * The attribution this module applies to one failed stage, for a caller
 * that observes the same target through another session (the activation
 * orchestrator's S7 census). Only the StorageOperationError family is
 * accepted, so the caller keeps deciding what an unrecognized error means;
 * a readiness error for an unacceptable expectedOwner still throws
 * MigrationTargetHealthError, as it does for the health check itself.
 */
export function classifyMigrationTargetFailure(
  error: StorageOperationError,
  stage: string,
): Exclude<MigrationTargetHealthResult, { status: "healthy" }> {
  return classifyFailure(error, stage);
}

function validateInput(input: MigrationTargetHealthInput): void {
  if (
    typeof input !== "object"
    || input === null
    || typeof input.runtime !== "object"
    || input.runtime === null
    || typeof input.runtime.health !== "function"
    || typeof input.runtime.query !== "function"
    || typeof input.expectedOwner !== "string"
    || input.expectedOwner.length === 0
  ) {
    throw new MigrationTargetHealthError("invalid-input", "migration target health input is invalid");
  }
}

/**
 * Observe the activation target's health as the factory would, but report
 * the attributed three-valued result described in the module doc comment
 * instead of one opaque failure. Never throws for a target condition.
 */
export async function checkMigrationTargetHealth(
  input: MigrationTargetHealthInput,
  dependencies: MigrationTargetHealthDependencies = {},
): Promise<MigrationTargetHealthResult> {
  validateInput(input);
  const verifyRuntimeSchema = dependencies.verifyRuntimeSchema ?? verifyPostgreSqlRuntimeSchema;
  if (input.signal?.aborted === true) {
    return unresolvable("aborted", "the caller aborted before the health probe ran");
  }

  let health: PostgreSqlRuntimeHealth;
  try {
    health = await input.runtime.health(input.signal);
  } catch (error) {
    return classifyFailure(error, "health probe");
  }
  // Widened on purpose: a fake (or a future StorageHealth variant) may hand
  // back a status outside today's union, and that must land in "unknown"
  // below rather than be mistaken for healthy.
  const status: string = health.status;
  if (status === "closed") {
    return unresolvable("runtime-closed", "health probe: the runtime reported itself closed");
  }
  if (status === "degraded") {
    return unresolvable(
      "pool-degraded",
      "health probe: the runtime's pool reported an earlier asynchronous failure, so the probe's connection cannot be vouched for",
    );
  }
  if (status === "unavailable") {
    if (health.error === undefined) {
      return unresolvable("unknown", "health probe: unavailable without an attributable error");
    }
    return classifyFailure(health.error, "health probe");
  }
  if (status !== "healthy") {
    return unresolvable("unknown", "health probe: unrecognized health status " + status);
  }

  let readiness: PostgreSqlRuntimeReadiness;
  try {
    readiness = await verifyRuntimeSchema(input.runtime, { expectedOwner: input.expectedOwner, signal: input.signal });
  } catch (error) {
    return classifyFailure(error, "schema check");
  }
  return { status: "healthy", readiness };
}

