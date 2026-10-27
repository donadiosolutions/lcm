import { PostgreSqlRuntime } from "../storage/postgresql/runtime.js";
import { verifyPostgreSqlTransferSchema, PostgreSqlRuntimeReadinessError } from "../storage/postgresql/runtime-readiness.js";
import type { PostgreSqlConnectionSettings } from "../storage/postgresql/contracts.js";

/**
 * **The distinction that decides exit 2 versus exit 5, per the owner's
 * explicit requirement -- verified empirically, not assumed from the type.**
 * `verifyPostgreSqlSchema` (`runtime-readiness.ts`'s shared implementation
 * behind both `verifyPostgreSqlTransferSchema` and
 * `verifyPostgreSqlRuntimeSchema`) has one outer catch-all that wraps
 * *any* unrecognised throw -- including a raw connection refusal, a TLS
 * handshake failure, or a DNS failure, confirmed by instrumenting a real
 * unreachable-target call -- into the exact same
 * `PostgreSqlRuntimeReadinessError` with reason `"server-preflight"` that a
 * genuinely-connected server failing its version/encoding/timezone/TLS
 * checks also produces. `PostgreSqlRuntimeReadinessError`'s type alone is
 * therefore not sufficient to distinguish "verification failed" from
 * "verification could not be performed" -- a first draft here assumed it
 * was, and would have misclassified every unreachable target as a
 * role/schema failure with a remedy that tells the operator to fix a role
 * that was never reached.
 *
 * Every *other* `PostgreSqlRuntimeReadinessError` reason
 * (`invalid-expected-owner`, `runtime-role-policy`, `extension-preflight`,
 * `content-collation-preflight`, `search-preflight`, `migration-ledger`,
 * `schema-ownership`, `schema-fingerprint`, `acl-shape`,
 * `effective-privilege`) is thrown only from code that runs strictly after
 * `inspectServerReadiness` already succeeded, so those reasons are safe to
 * treat as "verification failed" (exit 2, a real remedy exists).
 * `"server-preflight"` specifically is treated as unresolvable (exit 5)
 * instead, because it is the one reason that could mean either "reached
 * the server and it failed preflight" or "never reached the server at
 * all" -- and per the owner's framing, "I could not reach it" is not
 * "it is wrong", so the ambiguous case resolves to the safer, less
 * conclusive answer rather than a guessed one.
 */

export type MigrationTargetVerification =
  | Readonly<{ status: "verified" }>
  | Readonly<{
    status: "refuse";
    reason: "invalid-expected-owner" | "migration-target-verification-failed" | "migration-target-verification-unresolvable";
    evidence?: string;
  }>;

export type MigrationTargetVerificationOperations = Readonly<{
  createRuntime: (settings: PostgreSqlConnectionSettings) => PostgreSqlRuntime;
  verifyTransferSchema: typeof verifyPostgreSqlTransferSchema;
}>;

export async function verifyMigrationTargetReachability(input: Readonly<{
  settings: PostgreSqlConnectionSettings;
  expectedOwner: string;
  signal?: AbortSignal;
  /**
   * @internal Deterministic failure-injection seam for tests only, matching
   * the `_operationsForTesting` convention used elsewhere in
   * `src/migration/`.
   */
  _operationsForTesting?: Partial<MigrationTargetVerificationOperations>;
}>): Promise<MigrationTargetVerification> {
  const createRuntime = input._operationsForTesting?.createRuntime ?? ((settings) => new PostgreSqlRuntime(settings));
  const verifyTransferSchema = input._operationsForTesting?.verifyTransferSchema ?? verifyPostgreSqlTransferSchema;

  let runtime: PostgreSqlRuntime;
  try {
    runtime = createRuntime(input.settings);
  } catch (error) {
    return {
      status: "refuse",
      reason: "migration-target-verification-unresolvable",
      evidence: error instanceof Error ? error.name : "unknown-runtime-construction-failure",
    };
  }

  try {
    await verifyTransferSchema(runtime, { expectedOwner: input.expectedOwner, signal: input.signal });
    return { status: "verified" };
  } catch (error) {
    if (error instanceof PostgreSqlRuntimeReadinessError && error.reason === "invalid-expected-owner") {
      // Round-1 B-10: a purely local shape check that runs before any
      // connection, so it must not be reported as "the server was reached
      // and failed verification".
      return { status: "refuse", reason: "invalid-expected-owner", evidence: `readiness-${error.reason}` };
    }
    if (error instanceof PostgreSqlRuntimeReadinessError && error.reason !== "server-preflight") {
      // A real connection was established and the check genuinely came
      // back negative -- answerable, and the operator has a real action.
      // "server-preflight" is deliberately excluded above: it is also the
      // blanket catch-all for a connection that was never established at
      // all (see the module doc), so it cannot honestly be asserted as a
      // role/schema failure.
      return {
        status: "refuse",
        reason: "migration-target-verification-failed",
        evidence: `readiness-${error.reason}`,
      };
    }
    // Connection refused, TLS handshake failure, DNS failure, timeout, or
    // any other unattributable failure: "I could not reach it" is not
    // "it is wrong", so this is unresolvable, never a guessed role/schema
    // failure the check never actually reached.
    return {
      status: "refuse",
      reason: "migration-target-verification-unresolvable",
      evidence: error instanceof Error ? error.name : "unknown-verification-failure",
    };
  } finally {
    try {
      await runtime.close();
    } catch {
      // Preserve whichever outcome was already determined above; a close
      // failure after a successful or already-classified verification is
      // not itself new evidence about the target.
    }
  }
}
