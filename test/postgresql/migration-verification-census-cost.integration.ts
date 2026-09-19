import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { beforeAll, expect, it } from "vitest";
import { assertHarnessReady, settings, withPostgreSqlTestDatabase } from "./harness.js";
import { grantPortablePostgreSql, seedPortablePostgreSql } from "./portable-fixture.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import { PostgreSqlConversationRepository } from "../../src/storage/postgresql/conversation-repository.js";
import { probePostgreSqlPortableDestination } from "../../src/storage/postgresql/portable-destination.js";
import { PORTABLE_RECORD_DOMAIN_ORDER } from "../../src/storage/portable-record.js";
import {
  assertPermanentReadOnlyGuard,
  readFencedDestinationCensus,
  readLedgerMismatches,
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
 *
 * Covers the full in-window read as it actually runs today: the census
 * (readFencedDestinationCensus, which now also collects relation-class
 * dependency edges via a second readDomainPage walk over the same open
 * source), the sequence self-consistency check, and the ledger class
 * (three-table SQL against transfer_runs/transfer_batches/
 * transfer_identities). The file name says "census cost" for historical
 * continuity with earlier measurements; the numbers below are the whole
 * window, not the census alone, and are labelled per-phase so a reader
 * does not have to guess which figure is which.
 */
it("measures the full live in-window read against a realistic destination and records the numbers", async () => {
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
    // {transfer: true}: the ledger phase needs lcm.transfer_runs/
    // transfer_batches/transfer_identities privileges, which the default
    // grant profile omits.
    await grantPortablePostgreSql(db, { transfer: true });

    const runtime = new PostgreSqlRuntime(settings(db.runtimeUrl));
    const scratchParent = mkdtempSync(join(tmpdir(), "lcm-pg-census-cost-"));
    try {
      // Phase 1: the public probe, which reads through the ordinary
      // repository path before the fenced read-only window opens.
      const probeStart = performance.now();
      const repository = new PostgreSqlConversationRepository(runtime, seeded.expectedIdentity.id);
      const publicRows = await repository.listConversations();
      const probeMs = performance.now() - probeStart;

      // Also before the window, per plan-v4 step 2: the destination probe
      // whose identityFingerprintSha256 the ledger class consumes.
      const destinationProbeStart = performance.now();
      const destinationProbe = await probePostgreSqlPortableDestination({
        settings: settings(db.runtimeUrl), expectedOwner: "lcm_test_migrator", expectedIdentity: seeded.expectedIdentity,
      });
      const destinationProbeMs = performance.now() - destinationProbeStart;

      // A real, populated ledger fixture, seeded to match the row count
      // this destination will actually census below, so the ledger
      // phase measures real three-table SQL against real cardinality
      // rather than a fast-fail empty-run short circuit.
      const warmupSession = await runtime.openReadOnlySnapshot({ projectId: seeded.expectedIdentity.id });
      let totalRecordCount = 0;
      const identityRows: Array<{ domain: string; identitySha256: string }> = [];
      try {
        const warmupRead = await readFencedDestinationCensus(warmupSession, {
          settings: settings(db.runtimeUrl), expectedOwner: "lcm_test_migrator",
          expectedIdentity: seeded.expectedIdentity, scratchParent,
        });
        totalRecordCount = warmupRead.census.reduce((sum, entry) => sum + entry.recordCount, 0);
        for (const [domain, identities] of warmupRead.recordIdentities) {
          for (const identitySha256 of identities) identityRows.push({ domain, identitySha256 });
        }
      } finally {
        await warmupSession.close();
      }
      const runId = "census-cost-ledger-run";
      const targetGenerationId = "census-cost-ledger-target";
      const manifestSha256 = "d".repeat(64);
      await db.migrator.query({
        text: "INSERT INTO lcm.transfer_runs "
          + "(run_id, target_generation, project_id, manifest_bytes, manifest_sha256, schema_sha256, project_sha256, source_sha256, source_witness_sha256, state) "
          + "VALUES ($1, $2, $3, $4, $5, $5, $6, $5, $5, 'completed')",
        values: [runId, targetGenerationId, seeded.expectedIdentity.id, Buffer.from("{}"), manifestSha256, destinationProbe.identityFingerprintSha256],
      }, { domain: "factory", operation: "seedCensusCostLedgerRun" });
      const manifestCheckpoints = PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => ({
        domain, ordinal: 0, recordCount: 0,
        sourceCheckpointSha256: createHash("sha256").update("census-cost-checkpoint-" + domain).digest("hex"),
        destinationCommitSha256: createHash("sha256").update("census-cost-commit-" + domain).digest("hex"),
      }));
      await db.migrator.query({
        text: "INSERT INTO lcm.transfer_batches "
          + "(run_id, domain, prior_checkpoint_sha256, batch_sha256, checkpoint_bytes, checkpoint_sha256, first_ordinal, next_ordinal) "
          + "SELECT $1, d.domain, $2, $2, '{}'::bytea, d.checkpoint_sha256, 0, 0 "
          + "FROM unnest($3::text[], $4::text[]) AS d(domain, checkpoint_sha256)",
        values: [
          runId, "0".repeat(64),
          manifestCheckpoints.map((entry) => entry.domain),
          manifestCheckpoints.map((entry) => entry.sourceCheckpointSha256),
        ],
      }, { domain: "factory", operation: "seedCensusCostLedgerBatches" });
      await db.migrator.query({
        text: "INSERT INTO lcm.transfer_identities (run_id, domain, identity_sha256, ordinal, native_key, record_sha256) "
          + "SELECT $1, d.domain, d.identity_sha256, d.ordinal, "
          + "'census-cost-native-key-' || d.ordinal, encode(digest('census-cost-record-' || d.ordinal, 'sha256'), 'hex') "
          + "FROM unnest($2::text[], $3::text[], $4::bigint[]) AS d(domain, identity_sha256, ordinal)",
        values: [
          runId, identityRows.map((row) => row.domain), identityRows.map((row) => row.identitySha256),
          identityRows.map((_row, index) => index),
        ],
      }, { domain: "factory", operation: "seedCensusCostLedgerIdentities" });

      // Phase 2: the fenced window -- guard, census (plus its relation
      // edge walk), sequence check, ledger check -- all under one
      // borrowed read-only snapshot session, exactly as
      // verifyMigrationGeneration runs it.
      const session = await runtime.openReadOnlySnapshot({ projectId: seeded.expectedIdentity.id });
      let destinationRead: Awaited<ReturnType<typeof readFencedDestinationCensus>>;
      let guardMs: number;
      let censusMs: number;
      let sequenceMs: number;
      let ledgerMs: number;
      let identitySetDigestMs: number;
      try {
        const guardStart = performance.now();
        await assertPermanentReadOnlyGuard(session);
        guardMs = performance.now() - guardStart;

        const censusStart = performance.now();
        destinationRead = await readFencedDestinationCensus(session, {
          settings: settings(db.runtimeUrl), expectedOwner: "lcm_test_migrator",
          expectedIdentity: seeded.expectedIdentity, scratchParent,
        });
        censusMs = performance.now() - censusStart;

        const sequenceStart = performance.now();
        await readSequenceSelfConsistencyMismatches(session, seeded.expectedIdentity.id);
        sequenceMs = performance.now() - sequenceStart;

        const ledgerStart = performance.now();
        await readLedgerMismatches(session, {
          projectId: seeded.expectedIdentity.id, targetGenerationId,
          manifestSha256, identityFingerprintSha256: destinationProbe.identityFingerprintSha256,
          manifestCheckpoints, census: destinationRead.census,
          recordIdentities: destinationRead.recordIdentities,
        });
        ledgerMs = performance.now() - ledgerStart;

        // Round-4 P2: measured separately from ledgerMs (which already
        // includes it) so the added aggregate's own marginal cost is
        // directly checkable against the pre-declared abort threshold --
        // more than 10% of censusMs -- without needing a second,
        // before/after harness run. Same SQL text production runs.
        const identitySetDigestStart = performance.now();
        await session.query({
          text: "SELECT domain, encode(digest(string_agg(identity_sha256, '' ORDER BY identity_sha256 COLLATE \"C\"), 'sha256'), 'hex') AS identity_set_sha256 "
            + "FROM lcm.transfer_identities WHERE run_id = $1 GROUP BY domain",
          values: [runId],
        }, { domain: "factory", operation: "measureLedgerIdentitySetDigestCost" });
        identitySetDigestMs = performance.now() - identitySetDigestStart;
      } finally {
        await session.close();
      }
      const census = destinationRead.census;

      const windowMs = guardMs + censusMs + sequenceMs + ledgerMs;
      const totalMs = probeMs + destinationProbeMs + windowMs;
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
        "The file name is historical. The numbers below cover the whole",
        "in-window read as it runs today -- census (which now also collects",
        "relation-class dependency edges via a second readDomainPage walk",
        "over the same open source), sequence self-consistency, and the",
        "ledger class (three-table SQL against transfer_runs/",
        "transfer_batches/transfer_identities) -- not the census alone.",
        "Each phase is broken out below so a reader does not have to guess",
        "which figure is which.",
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
        "per-row round trips. A matching lcm.transfer_runs/transfer_batches/",
        "transfer_identities ledger fixture was also seeded, with",
        String(totalRecordCount) + " transfer_identities rows to match the",
        "real census total, so the ledger phase below measures real SQL",
        "against real cardinality rather than a fast-fail empty run.",
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
        "| destination probe (probePostgreSqlPortableDestination) | " + formatMs(destinationProbeMs) + " | before window |",
        "| read-only guard assertion | " + formatMs(guardMs) + " | inside window |",
        "| **census + relation edges (readFencedDestinationCensus, all 22 domains)** | **"
          + formatMs(censusMs) + "** | inside window |",
        "| sequence self-consistency check | " + formatMs(sequenceMs) + " | inside window |",
        "| ledger check (transfer_runs/transfer_batches/transfer_identities) | " + formatMs(ledgerMs) + " | inside window |",
        "| -- round-4 P2 identity-set digest query alone (measured standalone; not additive to the row above) | "
          + formatMs(identitySetDigestMs) + " | inside window |",
        "| window total (guard + census/relation + sequence + ledger) | " + formatMs(windowMs) + " | -- |",
        "| measured total (both pre-window probes + window) | " + formatMs(totalMs) + " | -- |",
        "",
        "Census+relation fraction of measured total: " + (censusFraction * 100).toFixed(1) + "%.",
        "",
        "Round-4 P2 identity-set digest query fraction of census+relation "
          + "(the pre-declared abort threshold operand): "
          + ((identitySetDigestMs / censusMs) * 100).toFixed(3) + "% (threshold: 10%).",
        "",
        "Persistence (the atomic content-addressed write in",
        "verification-store.ts) is a local file write after the lease is",
        "held and is not separately measured here; it is not read-scaling",
        "with destination size the way the in-window reads above are, so",
        "it is not the cost this measurement exists to bound.",
        "",
        "## Proposed lease TTL",
        "",
        "measured total = " + formatMs(totalMs) + " ms",
        "margin multiplier = " + String(marginMultiplier) + "x (stated assumption, not a second measurement)",
        "proposed leaseTtlMs = ceil(" + formatMs(totalMs) + " * " + String(marginMultiplier) + ") = " + String(proposedLeaseTtlMs) + " ms",
        "",
      ];
      // The evidence file this measurement regenerates lives at a
      // gitignored, repository-tree-relative path
      // (.superpowers/624/impl/census-cost.md) that only ever existed in
      // the worktrees that produced it. Deriving that path from
      // process.cwd() assumed a repository layout no clean checkout
      // guarantees: PR #1420's CI run failed with ENOENT on a fresh
      // checkout where .superpowers/ (and its parent, in that container)
      // never existed, even though the measurement itself succeeded in
      // about 68 seconds. The write is now opt-in, gated on an explicit
      // env var the caller supplies rather than a path this test
      // invents: set only when a developer is deliberately regenerating
      // the checked-in evidence file locally. When it is not set (every
      // CI run, and any environment that has not opted in), the report
      // is still produced and still logged, just not written to disk --
      // the measurement and its assertions below are unaffected either
      // way.
      const evidenceDir = process.env.LCM_MIGRATION_CENSUS_COST_EVIDENCE_DIR;
      if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true });
        writeFileSync(join(evidenceDir, "census-cost.md"), reportLines.join("\n"), "utf8");
      } else {
        console.log(reportLines.join("\n"));
      }

      expect(census).toHaveLength(22);
      expect(rowCountsByDomain.conversations).toBeGreaterThanOrEqual(BULK_CONVERSATION_COUNT);
      expect(censusMs).toBeGreaterThan(0);
      expect(ledgerMs).toBeGreaterThan(0);
      expect(totalMs).toBeGreaterThan(0);
    } finally {
      await runtime.close();
    }
  });
}, 300000);
