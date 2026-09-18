import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { beforeAll, expect, it } from "vitest";
import { assertHarnessReady, settings, withPostgreSqlTestDatabase } from "./harness.js";
import { grantPortablePostgreSql, seedPortablePostgreSql } from "./portable-fixture.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import { PostgreSqlConversationRepository } from "../../src/storage/postgresql/conversation-repository.js";
import {
  assertPermanentReadOnlyGuard,
  readFencedDestinationCensus,
  readSequenceSelfConsistencyMismatches,
} from "../../src/migration/verify-generation.js";

beforeAll(assertHarnessReady);

// A mid-size, single-project deployment's dominant growth domains:
// conversations, messages and message-parts. The other 21 portable domains
// keep whatever count the ordinary seedPortablePostgreSql fixture leaves
// them at (typically single digits); this measurement does not claim they
// are bulk-representative, only that they are exercised and counted.
const BULK_CONVERSATION_COUNT = 300;
const BULK_MESSAGES_PER_CONVERSATION = 15;

// A first attempt at this scale (2000 conversations x 20 messages =
// 40,000 messages, plus 40,000 message-parts) did not complete within a
// 120-second test budget: readFencedDestinationCensus's canonicalisation
// path reads one record at a time (see checkedRecordAt/readCanonicalRow
// in portable-source.ts, called per index entry rather than batched), so
// its cost is dominated by per-row round trips, not a fixed per-domain
// overhead. That is itself a real, load-bearing finding, recorded in
// census-cost.md below rather than discarded: a much larger destination
// than this one would extrapolate roughly linearly from the numbers here,
// and the round-trip-per-row shape is why. The scale below is what
// actually completed and produced a measured, not asserted, number.
const FIRST_ATTEMPT_DID_NOT_COMPLETE =
  "2000 conversations x 20 messages (40,000 messages, 40,000 message-parts) "
  + "did not complete within a 120s test budget";

function formatMs(value: number): string {
  return value.toFixed(1);
}

/**
 * Not a regression gate: performance numbers are environment-dependent and
 * asserting a fixed threshold here would be exactly the kind of invented
 * cost this item explicitly forbids. This test's job is to produce real,
 * measured numbers from a real PostgreSQL 18 instance and write them to
 * .superpowers/624/impl/census-cost.md verbatim, so the lease TTL proposal
 * in that file is derived from an actual run rather than an assumption.
 */
it("measures the live census pass against a realistic destination and records the numbers", async () => {
  await withPostgreSqlTestDatabase("migration-verification-census-cost", async (db) => {
    const seeded = await seedPortablePostgreSql(db.migrator);
    const bulkStart = performance.now();
    await db.migrator.query({
      text: "WITH inserted_conversations AS ("
        + "  INSERT INTO lcm.conversations (project_id, session_id, created_at, updated_at) "
        + "  SELECT $1, 'census-cost-bulk-' || g, now(), now() "
        + "  FROM generate_series(1, $2::int) AS g "
        + "  RETURNING conversation_id"
        + "), inserted_messages AS ("
        + "  INSERT INTO lcm.messages (project_id, conversation_id, seq, role, content, token_count, created_at) "
        + "  SELECT $1, c.conversation_id, s.seq, 'user', 'census cost bulk message content ' || s.seq, 12, now() "
        + "  FROM inserted_conversations c "
        + "  CROSS JOIN generate_series(0, $3::int - 1) AS s(seq) "
        + "  RETURNING conversation_id, message_id"
        + ") "
        + "INSERT INTO lcm.message_parts (project_id, conversation_id, message_id, session_id, part_type, ordinal, text_content) "
        + "SELECT $1, m.conversation_id, m.message_id, 'census-cost-bulk', 'text', 0, 'census cost bulk part content' "
        + "FROM inserted_messages m",
      values: [seeded.expectedIdentity.id, BULK_CONVERSATION_COUNT, BULK_MESSAGES_PER_CONVERSATION],
    }, { domain: "factory", operation: "seedCensusCostBulkFixture" });
    const bulkSeedMs = performance.now() - bulkStart;
    await grantPortablePostgreSql(db);

    const runtime = new PostgreSqlRuntime(settings(db.runtimeUrl));
    const scratchParent = mkdtempSync(join(tmpdir(), "lcm-pg-census-cost-"));
    try {
      // Phase 1: the public probe, which reads through the ordinary
      // repository path before the fenced read-only window opens.
      const probeStart = performance.now();
      const repository = new PostgreSqlConversationRepository(runtime, seeded.expectedIdentity.id);
      const publicRows = await repository.listConversations();
      const probeMs = performance.now() - probeStart;

      // Phase 2: the fenced window -- guard, census, sequence check --
      // all under one borrowed read-only snapshot session, exactly as
      // verifyMigrationGeneration runs it.
      const session = await runtime.openReadOnlySnapshot({ projectId: seeded.expectedIdentity.id });
      let census;
      let guardMs: number;
      let censusMs: number;
      let sequenceMs: number;
      try {
        const guardStart = performance.now();
        await assertPermanentReadOnlyGuard(session);
        guardMs = performance.now() - guardStart;

        const censusStart = performance.now();
        census = await readFencedDestinationCensus(session, {
          settings: settings(db.runtimeUrl), expectedOwner: "lcm_test_migrator",
          expectedIdentity: seeded.expectedIdentity, scratchParent,
        });
        censusMs = performance.now() - censusStart;

        const sequenceStart = performance.now();
        await readSequenceSelfConsistencyMismatches(session, seeded.expectedIdentity.id);
        sequenceMs = performance.now() - sequenceStart;
      } finally {
        await session.close();
      }

      const windowMs = guardMs + censusMs + sequenceMs;
      const totalMs = probeMs + windowMs;
      const censusFraction = censusMs / totalMs;
      // Margin rationale: 3x covers a destination roughly three times this
      // fixture's size, or equivalent disk/network degradation, without
      // requiring a lease renewal mid-window. This is a stated assumption,
      // not a second measurement; a reviewer should treat the multiplier,
      // not the base number, as the thing to challenge.
      const marginMultiplier = 3;
      const proposedLeaseTtlMs = Math.ceil(totalMs * marginMultiplier);

      const rowCountsByDomain = Object.fromEntries(
        census.map((entry) => [entry.domain, entry.recordCount]),
      );

      const reportLines = [
        "# Census cost measurement",
        "",
        "Measured against a live PostgreSQL 18 instance via the harness in",
        "test/postgresql/migration-verification-census-cost.integration.ts.",
        "Not a regression gate: these numbers are environment-dependent and",
        "this file is regenerated by running that test, not hand-edited.",
        "",
        "A first attempt at ten times this scale (" + FIRST_ATTEMPT_DID_NOT_COMPLETE + ") "
          + "was tried first and is recorded here rather than discarded: the",
        "census's canonicalisation path reads one record at a time per",
        "index entry (see checkedRecordAt/readCanonicalRow in",
        "portable-source.ts), so its cost is round-trip-dominated and",
        "roughly linear in row count. A destination ten times this size",
        "should extrapolate to roughly ten times the census time below,",
        "not a flat per-domain overhead.",
        "",
        "## Fixture",
        "",
        "One project. The ordinary seedPortablePostgreSql fixture (a",
        "handful of rows across all 22 portable domains) plus a bulk",
        "insert of " + String(BULK_CONVERSATION_COUNT) + " additional conversations, "
          + String(BULK_MESSAGES_PER_CONVERSATION) + " messages each ("
          + String(BULK_CONVERSATION_COUNT * BULK_MESSAGES_PER_CONVERSATION) + " messages total), one message-part",
        "per message. Conversations, messages and message-parts are this",
        "application's dominant growth domains in a real deployment; the",
        "other 21 domains were not bulk-scaled and keep the base fixture's",
        "row counts. Bulk insert itself (not part of the measured window)",
        "took " + formatMs(bulkSeedMs) + " ms via one server-side CTE, not",
        "per-row round trips.",
        "",
        "## Row counts per domain (from the census itself)",
        "",
        "| domain | recordCount |",
        "| --- | --- |",
        ...census.map((entry) => "| " + entry.domain + " | " + String(entry.recordCount) + " |"),
        "",
        "## Wall time by phase",
        "",
        "| phase | ms | in lease window? |",
        "| --- | --- | --- |",
        "| public probe (repository read, " + String(publicRows.length) + " rows) | " + formatMs(probeMs) + " | before window |",
        "| read-only guard assertion | " + formatMs(guardMs) + " | inside window |",
        "| **census (readFencedDestinationCensus, all 22 domains)** | **"
          + formatMs(censusMs) + "** | inside window |",
        "| sequence self-consistency check | " + formatMs(sequenceMs) + " | inside window |",
        "| window total (guard + census + sequence) | " + formatMs(windowMs) + " | -- |",
        "| measured total (probe + window) | " + formatMs(totalMs) + " | -- |",
        "",
        "Census fraction of measured total: " + (censusFraction * 100).toFixed(1) + "%.",
        "",
        "Persistence (the atomic content-addressed write in",
        "verification-store.ts) is a local file write after the lease is",
        "held and is not separately measured here; it is not read-scaling",
        "with destination size the way the census is, so it is not the",
        "cost this measurement exists to bound.",
        "",
        "## Proposed lease TTL",
        "",
        "measured total = " + formatMs(totalMs) + " ms",
        "margin multiplier = " + String(marginMultiplier) + "x (stated assumption, not a second measurement)",
        "proposed leaseTtlMs = ceil(" + formatMs(totalMs) + " * " + String(marginMultiplier) + ") = " + String(proposedLeaseTtlMs) + " ms",
        "",
      ];
      const outputDir = join(process.cwd(), ".superpowers/624/impl");
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(join(outputDir, "census-cost.md"), reportLines.join("\n"), "utf8");

      expect(census).toHaveLength(22);
      expect(rowCountsByDomain.conversations).toBeGreaterThanOrEqual(BULK_CONVERSATION_COUNT);
      expect(censusMs).toBeGreaterThan(0);
      expect(totalMs).toBeGreaterThan(0);
    } finally {
      await runtime.close();
    }
  });
}, 300000);
