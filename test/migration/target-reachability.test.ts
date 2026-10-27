import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyMigrationTargetReachability } from "../../src/migration/target-reachability.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verifyMigrationTargetReachability: injected boundaries (real-PostgreSQL cases live in test/postgresql/target-reachability.integration.ts)", () => {
  it("refuses invalid-expected-owner, not a verification failure, for an empty owner: the real local check runs before any connection (round-1 B-10)", async () => {
    const fakeRuntime = { close: vi.fn(async () => undefined) };
    const result = await verifyMigrationTargetReachability({
      settings: { url: "postgresql://unused/lcm", caFile: "/unused", poolMax: 1, connectionTimeoutMs: 100, idleTimeoutMs: 100, statementTimeoutMs: 100 },
      expectedOwner: "",
      _operationsForTesting: { createRuntime: () => fakeRuntime as never },
    });
    expect(result).toEqual({ status: "refuse", reason: "invalid-expected-owner", evidence: "readiness-invalid-expected-owner" });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("refuses migration-target-verification-unresolvable when the runtime cannot even be constructed", async () => {
    const result = await verifyMigrationTargetReachability({
      settings: { url: "postgresql://unused/lcm", caFile: "/unused", poolMax: 1, connectionTimeoutMs: 100, idleTimeoutMs: 100, statementTimeoutMs: 100 },
      expectedOwner: "lcm_test_migrator",
      _operationsForTesting: {
        createRuntime: () => { throw new Error("simulated construction failure"); },
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "migration-target-verification-unresolvable", evidence: "Error" });
  });

  it("refuses migration-target-verification-unresolvable with unknown-runtime-construction-failure for a non-Error construction throw", async () => {
    const result = await verifyMigrationTargetReachability({
      settings: { url: "postgresql://unused/lcm", caFile: "/unused", poolMax: 1, connectionTimeoutMs: 100, idleTimeoutMs: 100, statementTimeoutMs: 100 },
      expectedOwner: "lcm_test_migrator",
      _operationsForTesting: {
        createRuntime: () => { throw "not-an-error-object"; },
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "migration-target-verification-unresolvable", evidence: "unknown-runtime-construction-failure" });
  });

  it("refuses migration-target-verification-unresolvable with unknown-verification-failure for a non-Error, non-readiness verification throw", async () => {
    const fakeRuntime = { close: vi.fn(async () => undefined) };
    const result = await verifyMigrationTargetReachability({
      settings: { url: "postgresql://unused/lcm", caFile: "/unused", poolMax: 1, connectionTimeoutMs: 100, idleTimeoutMs: 100, statementTimeoutMs: 100 },
      expectedOwner: "lcm_test_migrator",
      _operationsForTesting: {
        createRuntime: () => fakeRuntime as never,
        verifyTransferSchema: async () => { throw "not-an-error-object"; },
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "migration-target-verification-unresolvable", evidence: "unknown-verification-failure" });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("preserves an already-determined verified outcome even when closing the runtime afterward throws", async () => {
    const fakeRuntime = { close: vi.fn(async () => { throw new Error("close failed"); }) };
    const result = await verifyMigrationTargetReachability({
      settings: { url: "postgresql://unused/lcm", caFile: "/unused", poolMax: 1, connectionTimeoutMs: 100, idleTimeoutMs: 100, statementTimeoutMs: 100 },
      expectedOwner: "lcm_test_migrator",
      _operationsForTesting: {
        createRuntime: () => fakeRuntime as never,
        verifyTransferSchema: async () => undefined,
      },
    });
    expect(result).toEqual({ status: "verified" });
  });

  it("converts a real (injected-instance) PostgreSqlRuntimeReadinessError into migration-target-verification-failed, carrying its reason", async () => {
    const { PostgreSqlRuntimeReadinessError } = await import("../../src/storage/postgresql/runtime-readiness.js");
    const fakeRuntime = { close: vi.fn(async () => undefined) };
    const result = await verifyMigrationTargetReachability({
      settings: { url: "postgresql://unused/lcm", caFile: "/unused", poolMax: 1, connectionTimeoutMs: 100, idleTimeoutMs: 100, statementTimeoutMs: 100 },
      expectedOwner: "lcm_test_migrator",
      _operationsForTesting: {
        createRuntime: () => fakeRuntime as never,
        verifyTransferSchema: async () => { throw new PostgreSqlRuntimeReadinessError("runtime-role-policy", "test"); },
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "migration-target-verification-failed", evidence: "readiness-runtime-role-policy" });
  });

  it("exercises the real default createRuntime/verifyTransferSchema wiring (no injection) against a genuinely unreachable address, landing on migration-target-verification-unresolvable via the verify-stage catch specifically -- a real, existing (if not cryptographically valid) CA file lets construction succeed so the failure is a real connection error, not a construction error (real PostgreSQL success/role-failure cases live in the .integration.ts counterpart, which the standard coverage gate does not run)", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "lcm-target-reachability-ca-"));
    const caFile = join(dir, "ca.crt");
    writeFileSync(caFile, "not-a-real-certificate-but-non-empty");
    try {
      const result = await verifyMigrationTargetReachability({
        settings: { url: "postgresql://user:password@127.0.0.1:1/lcm", caFile, poolMax: 1, connectionTimeoutMs: 500, idleTimeoutMs: 500, statementTimeoutMs: 500 },
        expectedOwner: "lcm_test_migrator",
      });
      expect(result.status).toBe("refuse");
      expect((result as { reason: string }).reason).toBe("migration-target-verification-unresolvable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("classifies server-preflight specifically as unresolvable (exit 5), not failed (exit 2), because that reason is also runtime-readiness.ts's blanket catch-all for a connection that was never established (red: removing the reason !== \"server-preflight\" exclusion would misclassify this as migration-target-verification-failed)", async () => {
    const { PostgreSqlRuntimeReadinessError } = await import("../../src/storage/postgresql/runtime-readiness.js");
    const fakeRuntime = { close: vi.fn(async () => undefined) };
    const result = await verifyMigrationTargetReachability({
      settings: { url: "postgresql://unused/lcm", caFile: "/unused", poolMax: 1, connectionTimeoutMs: 100, idleTimeoutMs: 100, statementTimeoutMs: 100 },
      expectedOwner: "lcm_test_migrator",
      _operationsForTesting: {
        createRuntime: () => fakeRuntime as never,
        verifyTransferSchema: async () => { throw new PostgreSqlRuntimeReadinessError("server-preflight", "test"); },
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "migration-target-verification-unresolvable", evidence: "PostgreSqlRuntimeReadinessError" });
  });
});
