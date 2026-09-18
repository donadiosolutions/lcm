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
  readSequenceSelfConsistencyMismatches,
  readSequenceStoredState,
  SEQUENCE_BACKED_IDENTITY_COLUMN,
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
            // "machines" is the wrong table for this probe: its portable
            // census scopes to this project only via an EXISTS join through
            // project_aliases/session_instructions/etc, so an injected row
            // with none of those links would never be counted regardless of
            // snapshot visibility. lcm.conversations carries project_id
            // directly, so a plain insert is visible to a project-scoped
            // census exactly when a fresh snapshot would see it.
            "INSERT INTO lcm.conversations (project_id, session_id, created_at, updated_at) "
            + "VALUES ($1, 'mid-pass-write-injection', now(), now())",
            [seeded.expectedIdentity.id],
          );
        } finally {
          await secondConnection.end();
        }
        const during = await readFencedDestinationCensus(session, {
          settings: settings(db.runtimeUrl), expectedOwner: "lcm_test_migrator",
          expectedIdentity: seeded.expectedIdentity, scratchParent,
        });
        const duringConversations = during.find((entry) => entry.domain === "conversations");
        expect(duringConversations?.recordCount).toBe(2);
      } finally {
        await session.close();
      }
      const after = await runtime.openReadOnlySnapshot({ projectId: seeded.expectedIdentity.id });
      try {
        const afterCensus = await readFencedDestinationCensus(after, {
          settings: settings(db.runtimeUrl), expectedOwner: "lcm_test_migrator",
          expectedIdentity: seeded.expectedIdentity, scratchParent,
        });
        const afterConversations = afterCensus.find((entry) => entry.domain === "conversations");
        expect(afterConversations?.recordCount).toBe(3);
      } finally {
        await after.close();
      }
    } finally {
      await runtime.close();
    }
  });
}, 60000);

/**
 * Live proof for S1 (synthesis round): pg_sequence_last_value() is scoped
 * to the calling session and reports NULL until that same session has
 * called nextval() itself, which a fresh read-only snapshot session never
 * has. The fixed implementation reads the sequence's own stored state
 * instead, so it must prove non-NULL and correct in exactly that fresh-
 * session shape, and must get the is_called boundary right in both
 * directions: never-called-with-collision, and reset-after-having-run.
 */
it("flags a never-called sequence whose start value collides with an already-copied row", async () => {
  await withPostgreSqlTestDatabase("migration-verification-sequence-never-called", async (db) => {
    const seeded = await seedPortablePostgreSql(db.migrator, { identityOnly: true });
    await grantPortablePostgreSql(db);
    // Bypasses nextval entirely via an explicit identity value: the
    // sequence backing conversation_id has never been called, so its
    // last_value still equals its start value, and that start value now
    // collides with a genuinely copied row.
    await db.migrator.query({
      text: "INSERT INTO lcm.conversations (conversation_id, project_id, session_id, created_at, updated_at) "
        + "OVERRIDING SYSTEM VALUE VALUES (1, $1, 'never-called-collision', now(), now())",
      values: [seeded.expectedIdentity.id],
    }, { domain: "factory", operation: "seedNeverCalledSequenceFixture" });
    const runtime = new PostgreSqlRuntime(settings(db.runtimeUrl));
    try {
      const session = await runtime.openReadOnlySnapshot({ projectId: seeded.expectedIdentity.id });
      try {
        const mismatches = await readSequenceSelfConsistencyMismatches(session, seeded.expectedIdentity.id);
        expect(mismatches).toEqual([{ domain: "conversations", class: "sequence", identitySha256: expect.any(String) }]);
      } finally {
        await session.close();
      }
    } finally {
      await runtime.close();
    }
  });
}, 60000);

it("passes a healthy sequence and flags the same sequence once reset, from a fresh read-only session each time", async () => {
  await withPostgreSqlTestDatabase("migration-verification-sequence-reset", async (db) => {
    const seeded = await seedPortablePostgreSql(db.migrator);
    await grantPortablePostgreSql(db);
    const runtime = new PostgreSqlRuntime(settings(db.runtimeUrl));
    try {
      // Healthy first: ordinary inserts during seeding already called
      // nextval, so last_value sits at or above every copied row's
      // identity. A fresh snapshot session must read that real, non-NULL
      // state rather than the session-local NULL the S1 defect produced.
      const healthySession = await runtime.openReadOnlySnapshot({ projectId: seeded.expectedIdentity.id });
      try {
        const healthy = await readSequenceSelfConsistencyMismatches(healthySession, seeded.expectedIdentity.id);
        expect(healthy.some((mismatch) => mismatch.domain === "conversations")).toBe(false);
      } finally {
        await healthySession.close();
      }
      await db.migrator.query({
        text: "SELECT setval(pg_catalog.pg_get_serial_sequence('lcm.conversations', 'conversation_id'), 1, true)",
      }, { domain: "factory", operation: "resetSequenceFixture" });
      const resetSession = await runtime.openReadOnlySnapshot({ projectId: seeded.expectedIdentity.id });
      try {
        const mismatches = await readSequenceSelfConsistencyMismatches(resetSession, seeded.expectedIdentity.id);
        expect(mismatches).toEqual([{ domain: "conversations", class: "sequence", identitySha256: expect.any(String) }]);
      } finally {
        await resetSession.close();
      }
    } finally {
      await runtime.close();
    }
  });
}, 60000);

/**
 * Three sources disagreed about what makes pg_sequences.last_value NULL:
 * a claim that pg_sequence_last_value() is session-local (wrong: dropped),
 * a claim that the view itself is privilege- or never-called-gated
 * (right, per postgresql.org/docs/current/view-pg-sequences.html), and no
 * source ever confirmed the never-called/privilege split empirically. This
 * settles it against the real harness rather than any of the three, and
 * is worth keeping permanently because it pins a behaviour that was
 * disputed, not merely a regression guard for one bug.
 */
it("establishes the on-disk sequence state from a fresh read-only snapshot session across all three states: never-called, called, and privilege-restricted", async () => {
  await withPostgreSqlTestDatabase("migration-verification-sequence-state-empirical", async (db) => {
    const seeded = await seedPortablePostgreSql(db.migrator, { identityOnly: true });
    await grantPortablePostgreSql(db);

    // Phase A: never-called. Nothing has ever invoked nextval() on this
    // sequence, so pg_sequences.last_value is genuinely NULL and the next
    // allocation must be read from start_value, not last_value.
    const neverCalledRuntime = new PostgreSqlRuntime(settings(db.runtimeUrl));
    try {
      const session = await neverCalledRuntime.openReadOnlySnapshot({ projectId: seeded.expectedIdentity.id });
      try {
        const state = await readSequenceStoredState(session, "lcm.conversations", "conversation_id");
        expect(state).toEqual({ kind: "never-called", startValue: 1n });
      } finally {
        await session.close();
      }
    } finally {
      await neverCalledRuntime.close();
    }

    // Phase B: called. An ordinary insert without OVERRIDING SYSTEM VALUE
    // lets GENERATED BY DEFAULT AS IDENTITY invoke nextval() for real, so
    // a fresh session afterwards must read a real, non-NULL last_value.
    await db.migrator.query({
      text: "INSERT INTO lcm.conversations (project_id, session_id) VALUES ($1, 'sequence-state-called-probe')",
      values: [seeded.expectedIdentity.id],
    }, { domain: "factory", operation: "seedCalledSequenceProbe" });
    const calledRuntime = new PostgreSqlRuntime(settings(db.runtimeUrl));
    try {
      const session = await calledRuntime.openReadOnlySnapshot({ projectId: seeded.expectedIdentity.id });
      try {
        const state = await readSequenceStoredState(session, "lcm.conversations", "conversation_id");
        expect(state.kind).toBe("called");
        if (state.kind === "called") {
          expect(state.lastValue).toBeGreaterThanOrEqual(1n);
          expect(state.incrementBy).toBe(1n);
        }
      } finally {
        await session.close();
      }
    } finally {
      await calledRuntime.close();
    }

    // Phase C: privilege-restricted. Revoking USAGE on this one identity
    // sequence -- a test-database-scoped revoke, never the shared
    // production grant profile -- must be told apart from "never called"
    // rather than collapsed into the same NULL.
    const administrator = new PostgreSqlRuntime(settings(db.adminUrl));
    try {
      await administrator.query({
        text: "REVOKE USAGE ON SEQUENCE lcm.conversations_conversation_id_seq FROM lcm_test_runtime",
      }, { domain: "factory", operation: "revokeSequenceUsageForPrivilegeProbe" });
    } finally {
      await administrator.close();
    }
    const restrictedRuntime = new PostgreSqlRuntime(settings(db.runtimeUrl));
    try {
      const session = await restrictedRuntime.openReadOnlySnapshot({ projectId: seeded.expectedIdentity.id });
      try {
        const state = await readSequenceStoredState(session, "lcm.conversations", "conversation_id");
        expect(state).toEqual({ kind: "privilege-denied" });
      } finally {
        await session.close();
      }
    } finally {
      await restrictedRuntime.close();
    }
  });
}, 60000);

/**
 * S2: the identity-sequence map is a hand-maintained completeness claim.
 * This proves it against pg_catalog rather than only against itself, so a
 * future migration adding an identity column cannot silently fall outside
 * the self-consistency bound's scope.
 */
it("maps exactly the identity-sequence-backed columns pg_catalog reports under schema lcm", async () => {
  await withPostgreSqlTestDatabase("migration-verification-sequence-completeness", async (db) => {
    await seedPortablePostgreSql(db.migrator, { identityOnly: true });
    const result = await db.migrator.query<{ table_name: string; column_name: string }>({
      text: "SELECT c.relname AS table_name, a.attname AS column_name "
        + "FROM pg_catalog.pg_attribute a "
        + "JOIN pg_catalog.pg_class c ON c.oid = a.attrelid "
        + "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace "
        + "WHERE n.nspname = 'lcm' AND a.attidentity <> '' AND c.relkind = 'r' AND NOT a.attisdropped "
        // fenced_leases.fencing_token is coordination-internal lease
        // machinery, not a portable domain, and is correctly out of scope
        // for this migration-verification bound.
        + "AND c.relname <> 'fenced_leases'",
    }, { domain: "factory", operation: "sequenceCompletenessProbe" });
    const actual = result.rows
      .map((row) => `${row.table_name}.${row.column_name}`)
      .sort();
    const expected = Object.values(SEQUENCE_BACKED_IDENTITY_COLUMN)
      .map((target) => `${target!.table.replace("lcm.", "")}.${target!.column}`)
      .sort();
    expect(actual).toEqual(expected);
  });
}, 60000);
