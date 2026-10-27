import { beforeAll, expect, it } from "vitest";
import { assertHarnessReady, settings, withPostgreSqlTestDatabase } from "./harness.js";
import { grantPortablePostgreSql } from "./portable-fixture.js";
import { verifyMigrationTargetReachability } from "../../src/migration/target-reachability.js";

beforeAll(assertHarnessReady);

it(
  "verifies for real against a real, correctly-granted migration role, and closes the runtime it opened",
  async () => {
    await withPostgreSqlTestDatabase("target-reachability-verified", async (db) => {
      await grantPortablePostgreSql(db, { transfer: true });
      const result = await verifyMigrationTargetReachability({
        settings: settings(db.runtimeUrl),
        expectedOwner: "lcm_test_migrator",
      });
      expect(result).toEqual({ status: "verified" });
    });
  },
  60000,
);

it(
  "refuses migration-target-verification-failed for a real connection to a role that was never granted (a real PostgreSqlRuntimeReadinessError, not injected)",
  async () => {
    await withPostgreSqlTestDatabase("target-reachability-wrong-role", async (db) => {
      // Grant only the base runtime privileges (so the connecting role,
      // lcm_test_runtime, can run the catalog queries readiness needs at
      // all) but deliberately withhold the transfer-specific grants --
      // lcm_test_migrator itself is created by the harness's own init
      // script but never receives the privileges verifyPostgreSqlTransferSchema
      // checks for, so this isolates a genuine ownership/privilege
      // failure from a connection-level permission failure (an earlier
      // draft granted nothing at all and got "permission denied for
      // table schema_migrations" on the connecting role itself, which
      // collapsed into the ambiguous server-preflight catch-all instead
      // of the specific readiness failure this test claims to prove).
      await grantPortablePostgreSql(db, { transfer: false });
      const result = await verifyMigrationTargetReachability({
        settings: settings(db.runtimeUrl),
        expectedOwner: "lcm_test_migrator",
      });
      expect(result.status).toBe("refuse");
      expect((result as { reason: string }).reason).toBe("migration-target-verification-failed");
      expect((result as { evidence?: string }).evidence).toMatch(/^readiness-/);
    });
  },
  60000,
);

it(
  "refuses migration-target-verification-unresolvable for a real, genuinely unreachable target (connection refused, not a role/schema failure)",
  async () => {
    const result = await verifyMigrationTargetReachability({
      settings: settings("postgresql://user:password@127.0.0.1:1/lcm", { connectionTimeoutMs: 500 }),
      expectedOwner: "lcm_test_migrator",
    });
    expect(result.status).toBe("refuse");
    expect((result as { reason: string }).reason).toBe("migration-target-verification-unresolvable");
  },
  15000,
);
