import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { beforeAll, expect, it } from "vitest";
import { assertHarnessReady, settings, withPostgreSqlTestDatabase } from "./harness.js";
import { grantPortablePostgreSql, seedPortablePostgreSql } from "./portable-fixture.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import {
  assertPermanentReadOnlyGuard,
  readFencedDestinationCensus,
} from "../../src/migration/verify-generation.js";

beforeAll(assertHarnessReady);

/**
 * Live PostgreSQL 18 proof for two invariants a fake cannot establish, per
 * review: a fake cannot prove PostgreSQL itself never assigned a
 * transaction id, and cannot prove a real committed write from a second
 * connection stays invisible inside an already-open REPEATABLE READ
 * snapshot.
 */

it("the census window is a real PostgreSQL READ ONLY transaction that never assigns a transaction id", async () => {
  await withPostgreSqlTestDatabase("migration-verification-readonly-guard", async (db) => {
    const seeded = await seedPortablePostgreSql(db.migrator);
    await grantPortablePostgreSql(db);
    const runtime = new PostgreSqlRuntime(settings(db.runtimeUrl));
    try {
      const session = await runtime.openReadOnlySnapshot({ projectId: seeded.expectedIdentity.id });
      try {
        const probe = await session.query<{ count: string }>({
          text: "SELECT count(*)::text AS count FROM lcm.machines",
        }, { domain: "transaction", operation: "readOnlyGuardLiveProbe", projectId: seeded.expectedIdentity.id });
        expect(Number(probe.rows[0]?.count)).toBeGreaterThanOrEqual(0);
        await expect(assertPermanentReadOnlyGuard(session)).resolves.toBeUndefined();
      } finally {
        await session.close();
      }
    } finally {
      await runtime.close();
    }
  });
}, 60000);

it("a write committed by a second connection during the fenced window is invisible to the census, and is caught once observed", async () => {
  await withPostgreSqlTestDatabase("migration-verification-mid-pass-write", async (db) => {
    const seeded = await seedPortablePostgreSql(db.migrator);
    await grantPortablePostgreSql(db);
    const runtime = new PostgreSqlRuntime(settings(db.runtimeUrl));
    const scratchParent = mkdtempSync(join(tmpdir(), "lcm-pg-migration-verification-"));
    try {
      const session = await runtime.openReadOnlySnapshot({ projectId: seeded.expectedIdentity.id });
      try {
        const secondConnection = new Client({ connectionString: db.migratorUrl, ssl: { rejectUnauthorized: false } });
        await secondConnection.connect();
        try {
          await secondConnection.query(
            "INSERT INTO lcm.machines (machine_id, identity_key, display_name, registered_at, last_seen_at) "
            + "VALUES (gen_random_uuid(), 'mid-pass-write-injection', NULL, now(), now())",
          );
        } finally {
          await secondConnection.end();
        }
        const during = await readFencedDestinationCensus(session, {
          settings: settings(db.runtimeUrl), expectedOwner: "lcm_test_migrator",
          expectedIdentity: seeded.expectedIdentity, scratchParent,
        });
        const duringMachines = during.find((entry) => entry.domain === "machines");
        expect(duringMachines?.recordCount).toBe(2);
      } finally {
        await session.close();
      }
      const after = await runtime.openReadOnlySnapshot({ projectId: seeded.expectedIdentity.id });
      try {
        const afterCensus = await readFencedDestinationCensus(after, {
          settings: settings(db.runtimeUrl), expectedOwner: "lcm_test_migrator",
          expectedIdentity: seeded.expectedIdentity, scratchParent,
        });
        const afterMachines = afterCensus.find((entry) => entry.domain === "machines");
        expect(afterMachines?.recordCount).toBe(3);
      } finally {
        await after.close();
      }
    } finally {
      await runtime.close();
    }
  });
}, 60000);
