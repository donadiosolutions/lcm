import { describe, expect, it } from "vitest";
import { StorageOperationError } from "../../src/storage/errors.js";
import type { PostgreSqlRuntimeHealth } from "../../src/storage/postgresql/contracts.js";
import {
  PostgreSqlCommitOutcomeUnknownError,
  PostgreSqlStorageOperationError,
} from "../../src/storage/postgresql/errors.js";
import {
  PostgreSqlRuntimeReadinessError,
  type PostgreSqlRuntimeReadiness,
  type PostgreSqlRuntimeReadinessFailureReason,
} from "../../src/storage/postgresql/runtime-readiness.js";
import {
  MigrationTargetHealthError,
  checkMigrationTargetHealth,
  type MigrationTargetHealthInput,
  type MigrationTargetHealthResult,
  type MigrationTargetHealthRuntime,
} from "../../src/migration/target-health.js";

const CONTEXT = { domain: "factory", operation: "health" } as const;

const READINESS: PostgreSqlRuntimeReadiness = Object.freeze({
  currentMigrationIds: Object.freeze(["0001"]),
  expectedOwner: "lcm_migrator",
  runtimeRole: "lcm_runtime",
  managedObjectCount: 3,
  definitionObjectCount: 3,
  privilegeManifestVersion: 1,
});

const HEALTHY: PostgreSqlRuntimeHealth = { status: "healthy", backend: "postgresql" };

function pgError(sqlState: string | null, retryable = false): PostgreSqlStorageOperationError {
  return new PostgreSqlStorageOperationError("STORAGE_INITIALIZATION_FAILED", CONTEXT, sqlState, retryable);
}

function runtime(
  health: () => Promise<PostgreSqlRuntimeHealth>,
  query: () => Promise<never> = () => Promise.reject(new Error("query must not be reached")),
): MigrationTargetHealthRuntime {
  return { health, query: query as unknown as MigrationTargetHealthRuntime["query"] };
}

/** A schema verifier that records it ran, so tests can assert the probe
 * short-circuits before the schema check on every non-healthy probe. */
function verifier(outcome: () => Promise<PostgreSqlRuntimeReadiness>) {
  const calls: Array<{ expectedOwner: string; signal: AbortSignal | undefined }> = [];
  const verifyRuntimeSchema = async (
    _executor: unknown,
    options: { readonly expectedOwner: string; readonly signal?: AbortSignal },
  ): Promise<PostgreSqlRuntimeReadiness> => {
    calls.push({ expectedOwner: options.expectedOwner, signal: options.signal });
    return outcome();
  };
  return { calls, verifyRuntimeSchema };
}

async function check(
  overrides: Partial<MigrationTargetHealthInput>,
  verify = verifier(() => Promise.resolve(READINESS)),
): Promise<{ result: MigrationTargetHealthResult; verify: ReturnType<typeof verifier> }> {
  const input: MigrationTargetHealthInput = {
    runtime: runtime(() => Promise.resolve(HEALTHY)),
    expectedOwner: "lcm_migrator",
    ...overrides,
  };
  const result = await checkMigrationTargetHealth(input, { verifyRuntimeSchema: verify.verifyRuntimeSchema });
  return { result, verify };
}

describe("checkMigrationTargetHealth: healthy", () => {
  it("is healthy only when the probe is healthy AND the factory's own schema check passes, passing the owner through", async () => {
    const signal = new AbortController().signal;
    const { result, verify } = await check({ signal });
    expect(result).toEqual({ status: "healthy", readiness: READINESS });
    expect(verify.calls).toEqual([{ expectedOwner: "lcm_migrator", signal }]);
  });

  it("uses verifyPostgreSqlRuntimeSchema by default (reaching the real catalog inspection through the injected executor)", async () => {
    // The real verifier's first server round trip goes through the
    // executor's query(). runtime-readiness.ts folds whatever that throws
    // into its ambiguous "server-preflight" reason (see the module doc
    // comment), so the only honest attribution here is
    // schema-check-indeterminate -- and reaching it proves the default
    // dependency is wired to the real check.
    const result = await checkMigrationTargetHealth({
      runtime: runtime(() => Promise.resolve(HEALTHY), () => Promise.reject(pgError("28P01"))),
      expectedOwner: "lcm_migrator",
    });
    expect(result).toMatchObject({ status: "unresolvable", reason: "schema-check-indeterminate", sqlState: null });
  });
});

describe("checkMigrationTargetHealth: unhealthy (definite server-side refusals)", () => {
  it.each([
    ["28000 invalid_authorization_specification", "28000"],
    ["28P01 invalid_password", "28P01"],
  ])("attributes %s to authentication-refused, not unresolvable", async (_name, sqlState) => {
    const { result, verify } = await check({
      runtime: runtime(() => Promise.resolve({ status: "unavailable", backend: "postgresql", error: pgError(sqlState) })),
    });
    expect(result).toMatchObject({ status: "unhealthy", reason: "authentication-refused", sqlState });
    expect(result.status).not.toBe("unresolvable");
    expect(verify.calls).toHaveLength(0);
  });

  it("attributes 42501 insufficient_privilege to insufficient-privilege", async () => {
    const { result } = await check({
      runtime: runtime(() => Promise.resolve({ status: "unavailable", backend: "postgresql", error: pgError("42501") })),
    });
    expect(result).toMatchObject({ status: "unhealthy", reason: "insufficient-privilege", sqlState: "42501" });
  });

  it("attributes any other definite, non-transport SQLSTATE (3D000 invalid_catalog_name) to server-refused", async () => {
    const { result } = await check({
      runtime: runtime(() => Promise.resolve({ status: "unavailable", backend: "postgresql", error: pgError("3D000") })),
    });
    expect(result).toMatchObject({ status: "unhealthy", reason: "server-refused", sqlState: "3D000" });
  });

  it("attributes the health probe's own preflight observation (a plain StorageOperationError) to server-preflight", async () => {
    const preflight = new StorageOperationError("STORAGE_INITIALIZATION_FAILED", "postgresql", undefined, "factory", "health");
    const { result } = await check({
      runtime: runtime(() => Promise.resolve({ status: "unavailable", backend: "postgresql", error: preflight })),
    });
    expect(result).toMatchObject({ status: "unhealthy", reason: "server-preflight", sqlState: null });
    expect((result as { detail: string }).detail).toContain("operation health");
  });

  it.each([
    "runtime-role-policy",
    "extension-preflight",
    "search-preflight",
    "content-collation-preflight",
    "schema-ownership",
    "migration-ledger",
    "schema-fingerprint",
    "acl-shape",
    "effective-privilege",
  ] as const satisfies readonly PostgreSqlRuntimeReadinessFailureReason[])(
    "attributes a definite readiness mismatch (%s) after a healthy probe to schema-mismatch, naming the reason",
    async (reason) => {
      const { result } = await check({}, verifier(() => Promise.reject(new PostgreSqlRuntimeReadinessError(reason))));
      expect(result).toMatchObject({ status: "unhealthy", reason: "schema-mismatch", sqlState: null });
      expect((result as { detail: string }).detail).toContain("(" + reason + ")");
    },
  );

  it("classifies a definite SQLSTATE thrown by the schema check itself (after a healthy probe) the same way", async () => {
    const { result } = await check({}, verifier(() => Promise.reject(pgError("42501"))));
    expect(result).toMatchObject({ status: "unhealthy", reason: "insufficient-privilege", sqlState: "42501" });
  });
});

describe("checkMigrationTargetHealth: unresolvable (could not look)", () => {
  it.each([
    ["08006 connection_failure", "08006", false],
    ["57P01 admin_shutdown", "57P01", false],
    ["57014 query_canceled (statement timeout)", "57014", false],
    ["53300 too_many_connections", "53300", true],
    ["40001 serialization_failure", "40001", true],
    ["XX000 internal_error", "XX000", false],
    ["25P03 idle_in_transaction_session_timeout", "25P03", false],
  ])("attributes %s to connection-failed, not unhealthy", async (_name, sqlState, retryable) => {
    const { result } = await check({
      runtime: runtime(() => Promise.resolve({
        status: "unavailable", backend: "postgresql", error: pgError(sqlState, retryable),
      })),
    });
    expect(result).toMatchObject({ status: "unresolvable", reason: "connection-failed", sqlState });
    expect(result.status).not.toBe("unhealthy");
  });

  it("attributes a retryable error carrying a normally-definite SQLSTATE to connection-failed (retryable wins)", async () => {
    const { result } = await check({
      runtime: runtime(() => Promise.resolve({ status: "unavailable", backend: "postgresql", error: pgError("28P01", true) })),
    });
    expect(result).toMatchObject({ status: "unresolvable", reason: "connection-failed", sqlState: "28P01" });
  });

  it("attributes a retryable transport error with no SQLSTATE (ECONNREFUSED, timeout) to connection-failed", async () => {
    const { result } = await check({
      runtime: runtime(() => Promise.resolve({ status: "unavailable", backend: "postgresql", error: pgError(null, true) })),
    });
    expect(result).toMatchObject({ status: "unresolvable", reason: "connection-failed", sqlState: null });
  });

  it("attributes a non-retryable error with no SQLSTATE to unknown, never to a definite refusal", async () => {
    const { result } = await check({
      runtime: runtime(() => Promise.resolve({ status: "unavailable", backend: "postgresql", error: pgError(null, false) })),
    });
    expect(result).toMatchObject({ status: "unresolvable", reason: "unknown", sqlState: null });
    expect((result as { detail: string }).detail).toContain("STORAGE_INITIALIZATION_FAILED");
  });

  it("attributes a commit-outcome-unknown transport loss to connection-failed", async () => {
    const { result } = await check({
      runtime: runtime(() => Promise.resolve({
        status: "unavailable", backend: "postgresql", error: new PostgreSqlCommitOutcomeUnknownError(CONTEXT),
      })),
    });
    expect(result).toMatchObject({ status: "unresolvable", reason: "connection-failed", sqlState: null });
  });

  it("attributes the readiness check's ambiguous server-preflight reason to schema-check-indeterminate, never to unhealthy", async () => {
    // runtime-readiness.ts wraps a mid-check transport failure AND a
    // definite server-setting mismatch into this one reason; a collapse
    // into "unhealthy: schema-mismatch" would make this assertion fail.
    const { result } = await check({}, verifier(() => Promise.reject(new PostgreSqlRuntimeReadinessError("server-preflight"))));
    expect(result).toMatchObject({ status: "unresolvable", reason: "schema-check-indeterminate", sqlState: null });
    expect(result.status).not.toBe("unhealthy");
  });

  it("reports a closed runtime (health status closed) as runtime-closed without running the schema check", async () => {
    const { result, verify } = await check({
      runtime: runtime(() => Promise.resolve({ status: "closed", backend: "postgresql" })),
    });
    expect(result).toMatchObject({ status: "unresolvable", reason: "runtime-closed" });
    expect(verify.calls).toHaveLength(0);
  });

  it("reports a STORAGE_CLOSED error thrown by the probe as runtime-closed", async () => {
    const closed = new StorageOperationError("STORAGE_CLOSED", "postgresql", undefined, "factory", "health");
    const { result } = await check({ runtime: runtime(() => Promise.reject(closed)) });
    expect(result).toMatchObject({ status: "unresolvable", reason: "runtime-closed" });
  });

  it("reports a degraded probe as pool-degraded rather than healthy or unhealthy", async () => {
    const { result, verify } = await check({
      runtime: runtime(() => Promise.resolve({ status: "degraded", backend: "postgresql" })),
    });
    expect(result).toMatchObject({ status: "unresolvable", reason: "pool-degraded" });
    expect(verify.calls).toHaveLength(0);
  });

  it("reports unavailable without an error object as unknown", async () => {
    const { result } = await check({
      runtime: runtime(() => Promise.resolve({ status: "unavailable", backend: "postgresql" })),
    });
    expect(result).toMatchObject({ status: "unresolvable", reason: "unknown" });
  });

  it("reports a health status outside the known union as unknown, never as healthy", async () => {
    const { result, verify } = await check({
      runtime: runtime(() => Promise.resolve({ status: "fine" as "healthy", backend: "postgresql" })),
    });
    expect(result).toMatchObject({ status: "unresolvable", reason: "unknown" });
    expect((result as { detail: string }).detail).toContain("fine");
    expect(verify.calls).toHaveLength(0);
  });

  it("reports an unrecognized thrown error (plain Error from the probe) as unknown, naming only its constructor", async () => {
    const { result } = await check({ runtime: runtime(() => Promise.reject(new RangeError("host=secret.internal"))) });
    expect(result).toMatchObject({ status: "unresolvable", reason: "unknown" });
    const detail = (result as { detail: string }).detail;
    expect(detail).toContain("RangeError");
    expect(detail).not.toContain("secret.internal");
  });

  it("reports an unrecognized non-Error rejection as unknown by its type", async () => {
    const { result } = await check({ runtime: runtime(() => Promise.reject("boom")) });
    expect(result).toMatchObject({ status: "unresolvable", reason: "unknown" });
    expect((result as { detail: string }).detail).toContain("string");
  });

  it("reports an already-aborted signal as aborted without touching the runtime", async () => {
    const controller = new AbortController();
    controller.abort();
    let probed = false;
    const { result, verify } = await check({
      runtime: runtime(() => { probed = true; return Promise.resolve(HEALTHY); }),
      signal: controller.signal,
    });
    expect(result).toMatchObject({ status: "unresolvable", reason: "aborted" });
    expect(probed).toBe(false);
    expect(verify.calls).toHaveLength(0);
  });
});

describe("checkMigrationTargetHealth: caller programming errors throw, target conditions never do", () => {
  it.each([
    ["non-object input", null],
    ["missing runtime", { expectedOwner: "lcm_migrator" }],
    ["runtime without health", { runtime: { query: () => undefined }, expectedOwner: "lcm_migrator" }],
    ["runtime without query", { runtime: { health: () => undefined }, expectedOwner: "lcm_migrator" }],
    ["empty expectedOwner", { runtime: runtime(() => Promise.resolve(HEALTHY)), expectedOwner: "" }],
    ["non-string expectedOwner", { runtime: runtime(() => Promise.resolve(HEALTHY)), expectedOwner: 7 }],
  ])("rejects %s with invalid-input before any probe", async (_name, input) => {
    await expect(checkMigrationTargetHealth(input as unknown as MigrationTargetHealthInput)).rejects.toMatchObject({
      name: "MigrationTargetHealthError",
      reason: "invalid-input",
    });
  });

  it("rethrows the readiness check's own invalid-expected-owner refusal as invalid-input (not a target condition)", async () => {
    const verify = verifier(() => Promise.reject(new PostgreSqlRuntimeReadinessError("invalid-expected-owner")));
    await expect(check({ expectedOwner: "has\u0000control" }, verify)).rejects.toBeInstanceOf(MigrationTargetHealthError);
  });
});

