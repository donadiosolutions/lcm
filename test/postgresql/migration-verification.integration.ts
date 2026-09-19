import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "pg";
import { beforeAll, expect, it, vi } from "vitest";
import { assertHarnessReady, settings, withPostgreSqlTestDatabase } from "./harness.js";
import { grantPortablePostgreSql, seedPortablePostgreSql } from "./portable-fixture.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import { probePostgreSqlPortableDestination } from "../../src/storage/postgresql/portable-destination.js";
import { PORTABLE_RECORD_DOMAIN_ORDER } from "../../src/storage/portable-record.js";
import {
  assertPermanentReadOnlyGuard,
  captureDestinationIdentity,
  captureDestinationSchemaWitness,
  readFencedDestinationCensus,
  readLedgerMismatches,
  readRelationDanglingReferenceMismatches,
  reconcileDependencyEdges,
  runSearchSelfMatchProbe,
  readSequenceSelfConsistencyMismatches,
  readSequenceStoredState,
  SEQUENCE_BACKED_IDENTITY_COLUMN,
  verifyMigrationGeneration,
} from "../../src/migration/verify-generation.js";
import { migrationCopyTargetGeneration } from "../../src/migration/copy-source.js";
import { inspectSqliteMigrationCopy, runSqliteMigrationCopy } from "../../src/migration/batch-copy.js";
import { beginMigrationEffect, completeMigrationEffect, createMigrationManifest } from "../../src/migration/protocol.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import {
  authenticateSqliteMigrationSource, authenticateSqliteMigrationSourceBytes,
  captureAuthenticatedSqliteMigrationSource, prepareSqliteMigrationEnrollment,
} from "../../src/migration/maintenance.js";
import { getMigrationReceiptEpoch, recordMigrationReceipt, type MigrationReceiptEnvelope } from "../../src/migration/receipts.js";
import { withMigrationQueueEvidence } from "../../src/migration/queue-evidence.js";
import { localProjectIdentity } from "../../src/daemon/project.js";
import {
  BackendPublicationCoordinator, withBackendPublicationAppendBarrierAsync,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";
import { PostgreSqlIdentityRepository } from "../../src/storage/postgresql/identity-repository.js";
import { appendLocalHookEvents } from "../../src/hooks/local-enqueue.js";
import { readMachineIdentity } from "../../src/machine-identity.js";
import { closeLcmConnection } from "../../src/db/connection.js";
import { seedPortableSqlite } from "../storage/sqlite-portable-fixture.js";

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


/**
 * Round-4 P1 end-to-end proof, the gap both reviewers found: no test
 * anywhere drove a real copy into verifyMigrationGeneration and
 * asserted eligibility. The two existing live tests for this probe
 * (the round-2 fixture-seeded ones above and in the unit suite) both
 * hand-wrote native_key as a bare id, which is not what the copy
 * actually writes (json_build_array(id::text)::text, per
 * portable-mapping.ts's locatorExpression) -- so they passed against a
 * format the destination never produces. This test performs a real
 * authenticated SQLite copy through runSqliteMigrationCopy (the same
 * driver bin/lcm.ts's migrate command uses), producing a genuine
 * lcm.transfer_identities table and a genuine on-disk manifest, then
 * calls verifyMigrationGeneration against that real destination with
 * verifyMigrationGeneration's own default dependencies (the real
 * openMigrationCopySource, not a stub), and asserts both a confirmed
 * search self-match and a genuinely activation-eligible report.
 */
it("a real authenticated SQLite copy verifies eligible, with a genuine search self-match against the copy's real locator format", async () => {
  await withPostgreSqlTestDatabase("migration-verification-e2e", async (db) => {
    await grantPortablePostgreSql(db, { transfer: true });
    const home = mkdtempSync(join(tmpdir(), "migration-verification-e2e-"));
    vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
    try {
      const cwd = join(home, "project"); mkdirSync(cwd, { mode: 0o700 });
      const local = localProjectIdentity(cwd, home);
      const projectDir = join(home, ".lcm", "projects", local.id);
      mkdirSync(projectDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(projectDir, "meta.json"), JSON.stringify({ cwd }) + "\n", { mode: 0o600 });
      const enrolled = await prepareSqliteMigrationEnrollment({
        cwd, homeDir: home,
        targetConfig: { backend: "postgresql", postgresql: { ...settings(db.runtimeUrl), migrationRole: "lcm_test_migrator" } },
      });
      const remote = await new PostgreSqlIdentityRepository(db.runtime).createProject({
        machineId: enrolled.identity.machineId, displayName: "verification e2e target", path: cwd, normalizedPath: cwd,
      });
      const expectedIdentity = {
        id: remote.projectId, remoteProjectId: remote.projectId, localProjectId: local.id,
        machineId: enrolled.identity.machineId, canonical: cwd, selectedPath: cwd,
      };
      const machine = readMachineIdentity(home)!;
      const seed = seedPortableSqlite(join(projectDir, "db.sqlite"), {
        projectIdentity: { scope: "shared", projectId: remote.projectId }, sourceLocalProjectId: local.id,
        identityFacts: {
          machines: [{ identityKey: machine.identityKey, machineId: machine.machineId }],
          aliases: [{ machineIdentityKey: machine.identityKey, path: cwd, normalizedPath: cwd }],
        },
      });
      if (Array.isArray(seed.capturedSidecars!.instructions)) {
        for (const file of seed.capturedSidecars!.instructions) rmSync(file.databasePath);
      }
      if ("databasePath" in seed.capturedSidecars!.events) rmSync(seed.capturedSidecars!.events.databasePath);
      await appendLocalHookEvents({
        cwd, sessionId: "retained", sourceHook: "SessionStart",
        events: ["applied", "no-effect", "retained"].map((data) => ({ type: "decision", category: "decision", data, priority: 1 })),
      });
      closeLcmConnection();
      const eventsPath = join(home, ".lcm", "events", local.id + ".db");
      const project = new DatabaseSync(join(projectDir, "db.sqlite"));
      const events = new DatabaseSync(eventsPath);
      try {
        const epoch = getMigrationReceiptEpoch(project, local.id, machine.machineId!)!;
        const envelopes = events.prepare(
          "SELECT event_uuid AS eventUuid, event_version AS eventVersion, machine_id AS machineId, "
            + "machine_sequence AS machineSequence, session_id AS sessionId, seq AS sessionSequence, "
            + "type, category, data, priority, source_hook AS sourceHook, created_at AS createdAt "
            + "FROM events ORDER BY machine_sequence",
        ).all() as unknown as MigrationReceiptEnvelope[];
        const memory = project.prepare("SELECT id FROM promoted ORDER BY id LIMIT 1").get() as { id: string };
        project.exec("BEGIN IMMEDIATE");
        for (const [index, envelope] of envelopes.slice(0, 2).entries()) {
          recordMigrationReceipt(project, {
            projectId: local.id, epochId: epoch.epochId, envelope,
            effectWitness: index === 0
              ? { version: 1, outcome: "applied", promotedMemoryId: memory.id }
              : { version: 1, outcome: "no-effect", reason: "unreinforced-pattern" },
            committedAt: "2026-09-14T03:00:00.000000Z",
          });
        }
        project.exec("COMMIT");
        events.exec("UPDATE events SET processed_at='2026-09-14T03:00:00.000Z' WHERE data IN ('applied','no-effect')");
      } finally {
        events.close(); project.close();
      }
      const unavailable = async (): Promise<never> => { throw new Error("no publication"); };
      const driver: BackendPublicationDriver = {
        observeLocalState: unavailable, publishProjectMap: unavailable, publishConfig: unavailable,
        restoreConfig: unavailable, restoreProjectMap: unavailable,
      };
      const entered = await withBackendPublicationAppendBarrierAsync(home, async (token) => {
        const authority = authenticateSqliteMigrationSource(cwd, home, token);
        const expectedSourceBytes = await authenticateSqliteMigrationSourceBytes(authority, { homeDir: home, lockToken: token });
        const held = await new BackendPublicationCoordinator({ homeDir: home, driver }).enterMaintenance({
          publicationId: "verify-e2e:all.1", generationId: "verify-e2e:all.1",
          sourceSelectionSha256: authority.sourceSelectionSha256, queueEvidenceSha256: expectedSourceBytes.checksumSha256,
          roster: [{ machineId: machine.machineId!, queueCutoff: "0000000000000000002", evidenceSha256: expectedSourceBytes.checksumSha256 }],
        }, token);
        return { authority, expectedSourceBytes, held };
      });
      const snapshot = await captureAuthenticatedSqliteMigrationSource(entered.authority, {
        homeDir: home, generationId: entered.held.generationId, maintenanceChecksumSha256: entered.held.checksumSha256,
        expectedSourceBytes: entered.expectedSourceBytes,
      });
      const evidence = await withMigrationQueueEvidence(home, snapshot.artifact, entered.held, async (_reference, records) => [...records]);
      expect(evidence.map((record) => record.disposition)).toEqual(["represented", "represented", "retained"]);
      closeLcmConnection();
      const copyInput = {
        generationId: snapshot.artifact.generationId, homeDir: home, settings: settings(db.runtimeUrl),
        expectedOwner: "lcm_test_migrator", expectedIdentity, ownerProcessId: "verify-e2e-copy-owner",
        maxRecords: 500, maxBytes: 150994944,
      };
      // runSqliteMigrationCopy reads an existing manifest head rather
      // than creating one itself -- the manifest is created here,
      // through the real protocol.ts constructor, from the same
      // witness inspectSqliteMigrationCopy derives, exactly like
      // batch-copy.ts's own production callers (bin/lcm.ts's migrate
      // command) are expected to do it.
      const witness = await inspectSqliteMigrationCopy({ ...copyInput, destinationCapturedAt: "2026-09-14T03:00:00.000Z" });
      const manifestStoreForCreate = new MigrationManifestStore({ homeDir: home });
      let createdJournal = manifestStoreForCreate.create(createMigrationManifest({
        generationId: copyInput.generationId, source: witness.source, destination: witness.destination,
        parentGenerationId: null, preservedSourceGenerationId: copyInput.generationId,
        createdAt: "2026-09-14T03:00:00.000Z",
      }));
      // runSqliteMigrationCopy requires the manifest to already be past
      // "planned" (dry-run-verified, copying, or copied) -- a real
      // caller runs a dry-run verification pass first. A minimal
      // synthetic dry-run report is sufficient here since this test's
      // subject is the copy and its ledger output, not the dry-run
      // report's own content.
      createdJournal = manifestStoreForCreate.update(copyInput.generationId, createdJournal.checksumSha256, (current) => beginMigrationEffect(current, {
        kind: "verify-dry-run", effectId: "e2e-dryrun", inputSha256: "a".repeat(64), startedAt: current.updatedAt,
      }));
      manifestStoreForCreate.update(copyInput.generationId, createdJournal.checksumSha256, (current) => completeMigrationEffect(current, {
        effectId: "e2e-dryrun", completedAt: current.updatedAt,
        report: { kind: "dry-run", reportId: "e2e-dryrun-verified", reportSha256: "b".repeat(64), createdAt: current.updatedAt },
      }));
      const result = await runSqliteMigrationCopy(copyInput);
      expect(result.phase).toBe("copied");
      expect(result.checkpoints).toHaveLength(22);

      // The manifest runSqliteMigrationCopy actually wrote to disk --
      // consumed directly, never restated, exactly like the driver's
      // own contract with MigrationManifestStore.
      const manifestStore = new MigrationManifestStore({ homeDir: home });
      const manifest = manifestStore.read(copyInput.generationId);
      expect(manifest.checkpoints).toHaveLength(22);

      // Destination witnesses computed through the exact functions the
      // driver itself uses, never re-derived independently, so this
      // input cannot silently drift from what verifyMigrationGeneration
      // will itself compute at step 2.
      const witnessRuntime = new PostgreSqlRuntime(settings(db.runtimeUrl));
      let destinationMigrationsSha256: string;
      let expectedDestinationIdentitySha256: string;
      let expectedSystemIdentifier: string;
      try {
        const [schemaWitness, identity] = await Promise.all([
          captureDestinationSchemaWitness(witnessRuntime),
          captureDestinationIdentity(witnessRuntime, expectedIdentity.id),
        ]);
        destinationMigrationsSha256 = schemaWitness.migrationsSha256;
        expectedDestinationIdentitySha256 = identity.sealedWitnessSha256;
        expectedSystemIdentifier = identity.systemIdentifier;
      } finally {
        await witnessRuntime.close();
      }

      const scratchParent = mkdtempSync(join(tmpdir(), "lcm-verify-e2e-scratch-"));
      const verified = await verifyMigrationGeneration({
        generationId: copyInput.generationId,
        targetGenerationId: migrationCopyTargetGeneration(copyInput.generationId),
        homeDir: home, expectedIdentity, destinationSettings: settings(db.runtimeUrl),
        expectedOwner: "lcm_test_migrator", ownerProcessId: "verify-e2e-verify-owner",
        scratchParent, leaseTtlMs: 300000,
        manifestRevision: manifest.revision, manifestChecksumSha256: manifest.checksumSha256,
        destinationMigrationsSha256, expectedDestinationIdentitySha256, expectedSystemIdentifier,
        // Neither of these is compared against anything live in
        // verify-generation.ts -- both are recorded into the report
        // verbatim for a future #625/#626 consumer, so a well-formed
        // placeholder is honest here, not a hidden second
        // implementation of something this driver itself checks.
        projectMapWitnessSha256: "a".repeat(64),
        queueClassificationWitness: {
          version: 1, queueCutoff: null, queueSetSha256: "a".repeat(64),
          receiptSetSha256: "a".repeat(64), epochChecksumSha256: "a".repeat(64),
        },
        sampleParameters: { version: 1, strideOrdinal: 97, sampleCount: 32, seedBasisSha256: "a".repeat(64) },
      });

      expect(verified.report.body.publicProbeCoverage).toContainEqual({ probe: "public-search", ran: true });
      expect(verified.report.mismatches).toEqual([]);
      expect(verified.report.activationEligible).toBe(true);
    } finally {
      closeLcmConnection(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true });
    }
  });
}, 120000);


/**
 * Live PostgreSQL 18 proof for the round-4 P1 fix: the search probe's
 * queries (lcm.transfer_runs run_id lookup, lcm.transfer_identities
 * correlation lookup, and the real full-text search through
 * PostgreSqlLexicalSearchRepository.searchMessages) are genuinely
 * exercised as SQL against a live database, not asserted against a
 * fake. Round-4's own sequence and ledger fixes were each caught only
 * by a live query throwing (a wrong pg_sequences join column, and a
 * missing transfer-table grant); the search probe's queries are new in
 * the same way and get the same proof rather than an inherited
 * assumption that they parse and execute correctly.
 */
it("the search probe's ledger correlation and real search both run as live SQL and confirm a genuine self-match", async () => {
  await withPostgreSqlTestDatabase("migration-verification-search-probe", async (db) => {
    const seeded = await seedPortablePostgreSql(db.migrator);
    // {transfer: true}: the correlation lookup needs
    // lcm.transfer_runs/transfer_identities privileges, the same as the
    // relation-and-ledger live test above.
    await grantPortablePostgreSql(db, { transfer: true });
    const runtime = new PostgreSqlRuntime(settings(db.runtimeUrl));
    try {
      const runId = "live-search-probe-run";
      const targetGenerationId = "live-search-probe-target";
      await db.migrator.query({
        text: "INSERT INTO lcm.transfer_runs "
          + "(run_id, target_generation, project_id, manifest_bytes, manifest_sha256, schema_sha256, project_sha256, source_sha256, source_witness_sha256, state) "
          + "VALUES ($1, $2, $3, $4, $5, $5, $5, $5, $5, 'completed')",
        values: [runId, targetGenerationId, seeded.expectedIdentity.id, Buffer.from("{}"), "d".repeat(64)],
      }, { domain: "factory", operation: "seedLiveSearchProbeRun" });
      // The picked identitySha256 is arbitrary (this test does not
      // exercise canonicalisation); what matters is that it is the
      // *only* fact tying the candidate to seeded.messageId, exactly
      // the correlation the fix performs live.
      const candidateIdentitySha256 = createHash("sha256").update("live-search-probe-candidate").digest("hex");
      // Round-4 P1 (candidate-review-4): native_key is the copy's own
      // JSON-array locator format (portable-mapping.ts's
      // locatorExpression: json_build_array(id::text)::text), never a
      // bare id. Seeding it as a bare id here previously let this test
      // pass against a format the destination never actually produces
      // -- exactly the defect both reviewers found in the production
      // code, just reproduced in the fixture instead.
      await db.migrator.query({
        text: "INSERT INTO lcm.transfer_identities (run_id, domain, identity_sha256, ordinal, native_key, record_sha256) "
          + "VALUES ($1, 'messages', $2, 0, $3, $4)",
        values: [runId, candidateIdentitySha256, JSON.stringify([seeded.messageId]), "e".repeat(64)],
      }, { domain: "factory", operation: "seedLiveSearchProbeIdentity" });

      const outcome = await runSearchSelfMatchProbe(
        runtime, seeded.expectedIdentity.id, targetGenerationId,
        [{ ordinal: 0, identitySha256: candidateIdentitySha256, content: "Portable primary message" }],
        "a".repeat(64),
      );
      expect(outcome).toEqual({ ran: true, chosenOrdinal: 0, notRunReason: null });

      // The live-negative half of the same proof: a candidate whose
      // content never appears in the destination at all must not be
      // confirmed by a live search that genuinely finds nothing, not
      // just by fake plumbing that always returns empty.
      const noMatchOutcome = await runSearchSelfMatchProbe(
        runtime, seeded.expectedIdentity.id, targetGenerationId,
        [{ ordinal: 0, identitySha256: candidateIdentitySha256, content: "no-such-content-exists-anywhere-zyx" }],
        "a".repeat(64),
      );
      expect(noMatchOutcome.ran).toBe(false);
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
        const duringConversations = during.census.find((entry) => entry.domain === "conversations");
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
        const afterConversations = afterCensus.census.find((entry) => entry.domain === "conversations");
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
 * Round-4 P1: identity sequences are global per table, shared across
 * every project, not per-project. Scoping the self-consistency bound's
 * MAX to the project being verified let a genuinely colliding row sit
 * undetected in a different project's rows of the very same table --
 * the verified project here has zero conversations of its own, so a
 * project-scoped MAX would see NULL and skip the domain entirely,
 * exactly the gap this closes. The other project's row is inserted with
 * OVERRIDING SYSTEM VALUE specifically so it never calls nextval() and
 * never advances the shared sequence, isolating the fixture to "a row
 * exists above the sequence" rather than "something already called
 * nextval a lot".
 */
it("flags a table-wide identity collision from another project even when the verified project's own domain is empty", async () => {
  await withPostgreSqlTestDatabase("migration-verification-sequence-cross-project", async (db) => {
    const seeded = await seedPortablePostgreSql(db.migrator, { identityOnly: true });
    await grantPortablePostgreSql(db);
    const otherProjectId = "01990000-0000-7000-8000-0000000000ff";
    // identity_key must match lcm.projects' CHECK constraint
    // ('^[a-f0-9]{64}$', a SHA-256 hex digest shape), never an
    // arbitrary descriptive string -- this was a real fixture defect,
    // confirmed by reading the actual PostgreSQL ERROR/DETAIL from a
    // live run (projects_identity_key_check), not assumed from where
    // the wrapping StorageOperationError's generic redacted message
    // happened to point.
    const otherProjectIdentityKey = createHash("sha256").update("cross-project-sequence-fixture-identity-key").digest("hex");
    await db.migrator.query({
      text: "INSERT INTO lcm.projects (project_id, identity_key, display_name, created_at, updated_at) "
        + "VALUES ($1, $2, 'Cross-project fixture', now(), now())",
      values: [otherProjectId, otherProjectIdentityKey],
    }, { domain: "factory", operation: "seedCrossProjectSequenceFixtureProject" });
    await db.migrator.query({
      text: "INSERT INTO lcm.conversations (conversation_id, project_id, session_id, created_at, updated_at) "
        + "OVERRIDING SYSTEM VALUE VALUES (999999, $1, 'other-project-collision', now(), now())",
      values: [otherProjectId],
    }, { domain: "factory", operation: "seedCrossProjectSequenceFixtureRow" });
    const runtime = new PostgreSqlRuntime(settings(db.runtimeUrl));
    try {
      const session = await runtime.openReadOnlySnapshot({ projectId: seeded.expectedIdentity.id });
      try {
        const mismatches = await readSequenceSelfConsistencyMismatches(session, seeded.expectedIdentity.id);
        expect(mismatches).toEqual(expect.arrayContaining([
          { domain: "conversations", class: "sequence", identitySha256: expect.any(String) },
        ]));
      } finally {
        await session.close();
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

/**
 * Live PostgreSQL 18 proof that the relation and ledger classes execute
 * real SQL correctly, not merely that a fake dispatcher agrees with
 * itself. The wrong-parent edge-set logic and the ledger mismatch logic
 * are both already proven at the unit level with fixtures constructed to
 * fail; this test proves the queries themselves -- readDomainPage-based
 * edge collection, and three-table SQL against transfer_runs/
 * transfer_batches/transfer_identities -- run outside a fake and agree
 * on a sound fixture, the same class of defect the sequence fix in this
 * file was for: a fake cannot see a query that throws or a column that
 * does not exist.
 */
it("relation and ledger read real SQL against a sound fixture and produce no mismatches", async () => {
  await withPostgreSqlTestDatabase("migration-verification-relation-ledger", async (db) => {
    const seeded = await seedPortablePostgreSql(db.migrator);
    // {transfer: true}: the ledger read needs lcm.transfer_runs/
    // transfer_batches/transfer_identities privileges, which the default
    // grant profile omits.
    await grantPortablePostgreSql(db, { transfer: true });
    const runtime = new PostgreSqlRuntime(settings(db.runtimeUrl));
    const scratchParent = mkdtempSync(join(tmpdir(), "lcm-pg-relation-ledger-"));
    try {
      const probe = await probePostgreSqlPortableDestination({
        settings: settings(db.runtimeUrl), expectedOwner: "lcm_test_migrator", expectedIdentity: seeded.expectedIdentity,
      });

      // Warm-up read: learn the real total record count so the ledger
      // fixture below can be seeded to match it exactly -- both the
      // total count and, per round-4 P2, the exact per-domain identity
      // sets, since the identity-set digest check compares the
      // destination's own recordIdentities against the ledger's per-
      // domain identity set and a total-only or fake-hash fixture would
      // now fail this test for the wrong reason. A second, authoritative
      // read happens after seeding, inside a fresh snapshot, which is
      // the one this test actually asserts against; nothing writes to
      // the destination between the two reads, so the two agree.
      const warmupSession = await runtime.openReadOnlySnapshot({ projectId: seeded.expectedIdentity.id });
      const identityRows: Array<{ domain: string; identitySha256: string }> = [];
      try {
        const warmupRead = await readFencedDestinationCensus(warmupSession, {
          settings: settings(db.runtimeUrl), expectedOwner: "lcm_test_migrator",
          expectedIdentity: seeded.expectedIdentity, scratchParent,
        });
        for (const [domain, identities] of warmupRead.recordIdentities) {
          for (const identitySha256 of identities) identityRows.push({ domain, identitySha256 });
        }
      } finally {
        await warmupSession.close();
      }

      const runId = "live-relation-ledger-run";
      const targetGenerationId = "live-relation-ledger-target";
      const manifestSha256 = "c".repeat(64);
      await db.migrator.query({
        text: "INSERT INTO lcm.transfer_runs "
          + "(run_id, target_generation, project_id, manifest_bytes, manifest_sha256, schema_sha256, project_sha256, source_sha256, source_witness_sha256, state) "
          + "VALUES ($1, $2, $3, $4, $5, $5, $6, $5, $5, 'completed')",
        values: [runId, targetGenerationId, seeded.expectedIdentity.id, Buffer.from("{}"), manifestSha256, probe.identityFingerprintSha256],
      }, { domain: "factory", operation: "seedLiveLedgerRun" });

      const manifestCheckpoints = PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => ({
        domain, ordinal: 0, recordCount: 0,
        sourceCheckpointSha256: createHash("sha256").update("live-checkpoint-" + domain).digest("hex"),
        destinationCommitSha256: createHash("sha256").update("live-commit-" + domain).digest("hex"),
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
      }, { domain: "factory", operation: "seedLiveLedgerBatches" });
      await db.migrator.query({
        text: "INSERT INTO lcm.transfer_identities (run_id, domain, identity_sha256, ordinal, native_key, record_sha256) "
          + "SELECT $1, d.domain, d.identity_sha256, d.ordinal, "
          + "'live-native-key-' || d.ordinal, encode(digest('live-record-' || d.ordinal, 'sha256'), 'hex') "
          + "FROM unnest($2::text[], $3::text[], $4::bigint[]) AS d(domain, identity_sha256, ordinal)",
        values: [
          runId, identityRows.map((row) => row.domain), identityRows.map((row) => row.identitySha256),
          identityRows.map((_row, index) => index),
        ],
      }, { domain: "factory", operation: "seedLiveLedgerIdentities" });

      const session = await runtime.openReadOnlySnapshot({ projectId: seeded.expectedIdentity.id });
      try {
        const destinationRead = await readFencedDestinationCensus(session, {
          settings: settings(db.runtimeUrl), expectedOwner: "lcm_test_migrator",
          expectedIdentity: seeded.expectedIdentity, scratchParent,
        });
        // The real destination compared against itself: proves the
        // readDomainPage-based edge walk executes real SQL successfully.
        // The wrong-parent case itself is proven red-first at the unit
        // level, which a fake can honestly establish since it is pure
        // data-structure logic, not a claim about live PostgreSQL.
        expect(reconcileDependencyEdges(destinationRead.dependencyEdges, destinationRead.dependencyEdges)).toEqual([]);
        expect(readRelationDanglingReferenceMismatches(destinationRead.dependencyEdges, destinationRead.recordIdentities)).toEqual([]);

        const ledgerMismatches = await readLedgerMismatches(session, {
          projectId: seeded.expectedIdentity.id, targetGenerationId,
          manifestSha256, identityFingerprintSha256: probe.identityFingerprintSha256,
          manifestCheckpoints, census: destinationRead.census,
          recordIdentities: destinationRead.recordIdentities,
        });
        expect(ledgerMismatches).toEqual([]);
      } finally {
        await session.close();
      }
    } finally {
      await runtime.close();
    }
  });
}, 60000);
