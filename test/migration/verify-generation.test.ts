import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrationWitnessSha256 } from "../../src/migration/activation-witness.js";
import * as coordination from "../../src/storage/postgresql/coordination.js";
import * as searchConfiguration from "../../src/storage/postgresql/search-configuration.js";
import * as portableSource from "../../src/storage/postgresql/portable-source.js";
import * as portableDestination from "../../src/storage/postgresql/portable-destination.js";
import { PORTABLE_INITIAL_CHECKPOINT_SHA256 } from "../../src/storage/postgresql/portable-destination.js";
import * as manifestStoreModule from "../../src/migration/manifest-store.js";
import * as copySourceModule from "../../src/migration/copy-source.js";
import * as runtimeReadiness from "../../src/storage/postgresql/runtime-readiness.js";
import {
  PORTABLE_RECORD_DOMAIN_ORDER, canonicalJson, derivePortableConversationIdentity, type PortableDomain,
} from "../../src/storage/portable-record.js";
import type { PortableCheckpoint } from "../../src/storage/portable-record-stream.js";
import type { StorageIdentityContext } from "../../src/storage/contracts.js";
import {
  beginMigrationEffect, completeMigrationEffect, createMigrationManifest,
  type MigrationCheckpoint, type MigrationManifest,
} from "../../src/migration/protocol.js";
import {
  MigrationVerificationDriverError,
  assertDestinationIdentityMatches,
  assertPermanentReadOnlyGuard,
  completePendingMigrationVerification,
  buildMigrationCanonicalDelta,
  buildMigrationCensusVector,
  inspectMigrationVerification,
  readFencedDestinationCensus,
  readLedgerMismatches,
  readRelationDanglingReferenceMismatches,
  reconcileDependencyEdges,
  readSequenceSelfConsistencyMismatches,
  MIGRATION_SEARCH_PROBE_CANDIDATE_POOL_SIZE,
  MIGRATION_SAMPLE_EMPTY_SOURCE_IDENTITY_SHA256,
  reconcileCounts,
  runOrderedListingProbe,
  SEQUENCE_BACKED_IDENTITY_COLUMN,
  sortMismatches,
  sortMismatchTotals,
  streamSourceCheckpoints,
  totalsFor,
  truncateMismatchesPerClass,
  verifyMigrationGeneration,
  type MigrationVerificationReceiptId,
  type VerifyMigrationGenerationDependencies,
  type VerifyMigrationGenerationInput,
} from "../../src/migration/verify-generation.js";
import { MigrationVerificationReportStore } from "../../src/migration/verification-store.js";
import { createMigrationVerificationReportBody, MIGRATION_MISMATCH_CLASSES, MIGRATION_PUBLIC_PROBE_ORDER } from "../../src/migration/verification-report.js";

const HASH_A = "a".repeat(64);
// Round-3 P2: verify-generation.ts now pins the pre-window search
// configuration read against the same compiled-in digest the schema
// installer enforces (POSTGRESQL_SEARCH_CONFIGURATION_SHA256), not
// just against a second in-window read of itself. Every "happy path"
// stub of inspectPostgreSqlSearchConfiguration below must return this
// real constant rather than an arbitrary fixture hash like HASH_A, or
// it now refuses before reaching whatever the test actually means to
// exercise.
const REAL_SEARCH_CONFIGURATION_SHA256 = searchConfiguration.POSTGRESQL_SEARCH_CONFIGURATION_SHA256;
const FAKE_MIGRATIONS = [{ id: "0001", filename: "0001.sql", sql: "", sha256: HASH_A }];
const EXPECTED_MIGRATIONS_SHA256 = createHash("sha256")
  .update(canonicalJson(FAKE_MIGRATIONS.map(({ id, sha256 }) => ({ id, sha256 }))), "utf8")
  .digest("hex");

function fakeHash(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

const LEDGER_TOTAL_RECORD_COUNT_DEFAULT = PORTABLE_RECORD_DOMAIN_ORDER.reduce(
  (sum, _domain, index) => sum + index, 0,
);

/** Shared by the default fake manifest and the default fake session's
 * transfer_batches response, so the two agree on a "clean" ledger by
 * construction rather than by two independently hand-maintained lists. */
function defaultLedgerCheckpoint(domain: PortableDomain): {
  domain: PortableDomain; ordinal: number; recordCount: number;
  sourceCheckpointSha256: string; destinationCommitSha256: string;
} {
  return {
    domain, ordinal: PORTABLE_RECORD_DOMAIN_ORDER.indexOf(domain), recordCount: PORTABLE_RECORD_DOMAIN_ORDER.indexOf(domain),
    sourceCheckpointSha256: fakeHash("ledger-checkpoint-" + domain), destinationCommitSha256: fakeHash("ledger-commit-" + domain),
  };
}

const MANIFEST_FIXTURE_GENERATION_ID = "generation-1";
const MANIFEST_FIXTURE_AT = "2026-01-01T00:00:00.000Z";
const MANIFEST_FIXTURE_SOURCE_WITNESS = {
  version: 1 as const, backend: "sqlite" as const, identitySha256: HASH_A,
  schemaSha256: HASH_A, contentSha256: HASH_A, capturedAt: MANIFEST_FIXTURE_AT,
};
const MANIFEST_FIXTURE_DESTINATION_WITNESS = {
  ...MANIFEST_FIXTURE_SOURCE_WITNESS, backend: "postgresql" as const, systemIdentifier: "7123456789",
};

/**
 * A manifest at phase "copied" with the given checkpoints, built by
 * driving the real protocol.ts state machine (beginMigrationEffect /
 * completeMigrationEffect / createMigrationManifest) rather than a
 * hand-rolled object shape. Steps 9-11 in verify-generation.ts call the
 * same real functions against whatever MigrationManifestStore.read()
 * returns, so a fixture that skipped this machinery would let a shape bug
 * pass silently instead of failing parseMigrationManifest's validation
 * the way a real store-backed manifest would.
 */
function buildCopiedManifestFixture(checkpoints: readonly MigrationCheckpoint[]): MigrationManifest {
  let manifest = createMigrationManifest({
    generationId: MANIFEST_FIXTURE_GENERATION_ID, source: MANIFEST_FIXTURE_SOURCE_WITNESS,
    destination: MANIFEST_FIXTURE_DESTINATION_WITNESS, parentGenerationId: null,
    preservedSourceGenerationId: MANIFEST_FIXTURE_GENERATION_ID, createdAt: MANIFEST_FIXTURE_AT,
  });
  manifest = beginMigrationEffect(manifest, {
    kind: "verify-dry-run", effectId: "fixture-dryrun", inputSha256: HASH_A, startedAt: MANIFEST_FIXTURE_AT,
  });
  manifest = completeMigrationEffect(manifest, {
    effectId: "fixture-dryrun", completedAt: MANIFEST_FIXTURE_AT,
    report: { kind: "dry-run", reportId: "fixture-dryrun-report", reportSha256: HASH_A, createdAt: MANIFEST_FIXTURE_AT },
  });
  for (const [index, checkpoint] of checkpoints.entries()) {
    const effectId = `fixture-batch-${index}`;
    manifest = beginMigrationEffect(manifest, {
      kind: "copy-batch", effectId, inputSha256: HASH_A, startedAt: MANIFEST_FIXTURE_AT,
    });
    manifest = completeMigrationEffect(manifest, { effectId, completedAt: MANIFEST_FIXTURE_AT, checkpoint });
  }
  manifest = beginMigrationEffect(manifest, {
    kind: "complete-copy", effectId: "fixture-complete-copy", inputSha256: HASH_A, startedAt: MANIFEST_FIXTURE_AT,
  });
  manifest = completeMigrationEffect(manifest, { effectId: "fixture-complete-copy", completedAt: MANIFEST_FIXTURE_AT });
  return manifest;
}

const DEFAULT_MANIFEST_CHECKPOINTS = PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => defaultLedgerCheckpoint(domain));

/**
 * Replaces MigrationManifestStore with an in-memory fake backed by a
 * mutable manifest advanced through the real state machine above. read()
 * and update() behave like the real store's checksum-based compare-and-
 * swap: an update() against a stale checksum throws, exactly like
 * MigrationManifestStore.update() does. Returns an accessor so a test can
 * inspect the manifest's final phase/pendingEffect/activationEligible.
 */
function fakeManifestStore(checkpoints: readonly MigrationCheckpoint[] = DEFAULT_MANIFEST_CHECKPOINTS): { current: MigrationManifest } {
  let current = buildCopiedManifestFixture(checkpoints);
  vi.spyOn(manifestStoreModule, "MigrationManifestStore").mockImplementation(function () {
    return {
      read: vi.fn(() => current),
      update: vi.fn((_generationId: string, expectedChecksumSha256: string, reduce: (manifest: MigrationManifest) => MigrationManifest) => {
        if (current.checksumSha256 !== expectedChecksumSha256) {
          throw new Error("migration manifest update is stale");
        }
        current = reduce(current);
        return current;
      }),
    } as never;
  });
  return {
    get current() { return current; },
    set current(value: MigrationManifest) { current = value; },
  };
}

/** Every test in this file reaches verifyMigrationGeneration's resume
 * check before anything else, so every test needs a working manifest
 * mock even if it never calls stubDestinationPrimitives() itself. A test
 * that wants specific checkpoints or a specific pending-effect state
 * calls fakeManifestStore() again to override this default. */
beforeEach(() => { fakeManifestStore(); });
const projectId = "01990000-0000-7000-8000-000000000001";
const machineId = "01990000-0000-7000-8000-000000000002";
const timestamp = "2026-09-06T12:34:56.123456Z";

function identity(): StorageIdentityContext {
  return {
    id: projectId, remoteProjectId: projectId, localProjectId: "a".repeat(64),
    machineId, selectedPath: "/source", displayName: "source",
  } as StorageIdentityContext;
}

function checkpoint(domain: PortableDomain, recordCount: number, prefixSha256: string): PortableCheckpoint {
  return {
    version: 1, manifestSha256: HASH_A, domain, nextOrdinal: recordCount, recordCount, prefixSha256,
    lastRecordIdentitySha256: recordCount === 0 ? null : HASH_A, lastRecordSha256: recordCount === 0 ? null : HASH_A,
  } as PortableCheckpoint;
}

/** The real portable identity a source conversation record carries, from the same shared derivation the driver uses. */
function conversationIdentity(
  sessionId: string, createdAt: string, title: string | null = null, occurrenceOrdinal = 0,
  updatedAt: string = createdAt, bootstrappedAt: string | null = null,
) {
  return derivePortableConversationIdentity([sessionId, title, bootstrappedAt, createdAt, updatedAt, occurrenceOrdinal]);
}

function fakeConversationRecord(createdAt: string, identitySeed: string, title: string | null = null, occurrenceOrdinal = 0) {
  const { conversationFingerprint, identitySha256 } = conversationIdentity(identitySeed, createdAt, title, occurrenceOrdinal);
  return {
    version: 1, domain: "conversations" as const, domainVersion: 1, ordinal: 0, order: [],
    identitySha256,
    dependencies: [],
    value: {
      conversationFingerprint, occurrenceOrdinal,
      sessionId: identitySeed, createdAt, title, bootstrappedAt: null, updatedAt: createdAt,
    },
    recordSha256: fakeHash("record-" + identitySeed),
  };
}

function fakeMessageRecord(content: string, identitySeed: string) {
  return {
    version: 1, domain: "messages" as const, domainVersion: 1, ordinal: 0, order: [],
    identitySha256: fakeHash(`message-identity-${identitySeed}`),
    dependencies: [],
    value: {
      conversationIdentitySha256: fakeHash(`conv-${identitySeed}`), seq: 1, role: "user" as const,
      content, tokenCount: 1, createdAt: timestamp,
    },
    recordSha256: fakeHash(`message-record-${identitySeed}`),
  };
}

function fakeStream(
  recordCounts: Partial<Record<PortableDomain, number>> = {},
  conversationsRecords: ReadonlyArray<ReturnType<typeof fakeConversationRecord>> = [],
  // Round-2 P1: the search self-match probe needs at least one candidate
  // with real content, or every test using the default fixture would
  // see searchProbeCandidates.length === 0 and sample.ran would always
  // be false regardless of what the test is actually exercising.
  messagesRecords: ReadonlyArray<ReturnType<typeof fakeMessageRecord>> = [fakeMessageRecord("a routine diagnostic message body", "default")],
) {
  return {
    readBatch: vi.fn(async ({ domain }: { domain: PortableDomain }) => {
      const records = domain === "conversations" ? conversationsRecords : domain === "messages" ? messagesRecords : [];
      const recordCount = recordCounts[domain] ?? 0;
      return {
        version: 1, manifestSha256: HASH_A, domain, records, framedBytes: 0, complete: true,
        priorCheckpointSha256: null, checkpoint: checkpoint(domain, recordCount, fakeHash(`prefix-${domain}-${recordCount}`)),
      };
    }),
    verify: vi.fn(),
    describe: vi.fn(() => ({ manifestSha256: HASH_A })),
    close: vi.fn(async () => { /* fake */ }),
  };
}

function fakeCopySource(overrides: {
  recordCounts?: Partial<Record<PortableDomain, number>>;
  conversationsRecords?: ReadonlyArray<ReturnType<typeof fakeConversationRecord>>;
  messagesRecords?: ReadonlyArray<ReturnType<typeof fakeMessageRecord>>;
  reauthenticate?: () => Promise<void>;
} = {}) {
  const stream = fakeStream(overrides.recordCounts, overrides.conversationsRecords, overrides.messagesRecords);
  return {
    homeDir: "/home", stream, snapshot: {}, sourceWitness: {
      version: 1, backend: "sqlite", identitySha256: HASH_A, schemaSha256: HASH_A, contentSha256: HASH_A, capturedAt: timestamp,
    },
    facts: {}, extraInstructionAbsenceSha256: HASH_A,
    reauthenticate: overrides.reauthenticate ?? vi.fn(async () => { /* fake */ }),
    reauthenticateHeld: vi.fn(async () => { /* fake */ }),
  };
}

const SEQUENCE_BACKED_TABLES: Record<string, string> = {
  conversations: "lcm.conversations",
  messages: "lcm.messages",
  "recall-surfacings": "lcm.recall_surfacing",
  "session-instructions": "lcm.session_instructions",
  "passive-events": "lcm.passive_event_inbox",
};

interface LedgerBatchRowFixture {
  domain: string; prior_checkpoint_sha256: string; checkpoint_sha256: string;
  first_ordinal: string; next_ordinal: string;
}

function fakeSession(overrides: {
  xid?: string | null;
  sequenceState?: Partial<Record<string, {
    maxValue: string | null; lastValue: string | null; isCalled?: boolean; incrementBy?: string;
    startValue?: string; privilegeDenied?: boolean;
  }>>;
  ledgerIdentityTotal?: number | null;
  ledgerRun?: { state?: string; manifestSha256?: string; projectSha256?: string } | null;
  ledgerCheckpoints?: readonly ReturnType<typeof defaultLedgerCheckpoint>[];
  /** Raw transfer_batches rows; replaces the single-row chain derived from ledgerCheckpoints. */
  ledgerBatchRows?: readonly LedgerBatchRowFixture[];
  ledgerNonInjective?: ReadonlyArray<{ domain: string; nativeKey: string }>;
  ledgerIdentitySets?: ReadonlyArray<{
    domain: string; identitySha256s: readonly string[];
    // The ledger's record_sha256 for each identity, in the same order;
    // omitted means the fixture's ledger carries no record digests.
    recordSha256s?: readonly string[];
  }>;
  identityColumns?: ReadonlyArray<{ tableName: string; columnName: string }>;
  migrationsRows?: ReadonlyArray<{ id: string; checksum_sha256: string }>;
  systemIdentifier?: string;
} = {}) {
  const sequenceState = overrides.sequenceState ?? {};
  const ledgerRun = overrides.ledgerRun === undefined
    ? { state: "completed", manifestSha256: HASH_A, projectSha256: HASH_A }
    : overrides.ledgerRun;
  const ledgerCheckpoints = overrides.ledgerCheckpoints
    ?? PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => defaultLedgerCheckpoint(domain));
  const ledgerIdentityTotal = overrides.ledgerIdentityTotal ?? LEDGER_TOTAL_RECORD_COUNT_DEFAULT;
  const ledgerNonInjective = overrides.ledgerNonInjective ?? [];
  const ledgerIdentitySets = overrides.ledgerIdentitySets;
  // Mirrors SEQUENCE_BACKED_IDENTITY_COLUMN by default, so the round-1
  // P2 completeness guard sees an agreeing "live schema" on the default
  // fixture. A test proving the guard fires overrides this to a
  // deliberately disagreeing set.
  const identityColumns = overrides.identityColumns ?? Object.values(SEQUENCE_BACKED_IDENTITY_COLUMN).map((target) => ({
    tableName: target!.table.replace("lcm.", ""), columnName: target!.column,
  }));
  const seqNameFor = (domain: string) => `lcm.fake_${domain}_seq`;
  return {
    identity: { sessionId: "window-session", backendPid: 999, projectId },
    query: vi.fn(async (config: { text: string; values?: readonly unknown[] }) => {
      if (config.text.includes("pg_current_xact_id_if_assigned")) return { rows: [{ xid: overrides.xid ?? null }] };
      if (config.text.includes("attidentity")) {
        return { rows: identityColumns.map(({ tableName, columnName }) => ({ table_name: tableName, column_name: columnName })) };
      }
      if (config.text.includes("lcm.transfer_runs")) {
        if (ledgerRun === null) return { rows: [] };
        return { rows: [{ run_id: "fake-run-id", state: ledgerRun.state, manifest_sha256: ledgerRun.manifestSha256, project_sha256: ledgerRun.projectSha256 }] };
      }
      if (config.text.includes("lcm.transfer_batches")) {
        return {
          rows: overrides.ledgerBatchRows ?? ledgerCheckpoints.map((entry) => ({
            domain: entry.domain, prior_checkpoint_sha256: PORTABLE_INITIAL_CHECKPOINT_SHA256,
            checkpoint_sha256: entry.sourceCheckpointSha256, first_ordinal: "0", next_ordinal: String(entry.ordinal),
          })),
        };
      }
      if (config.text.includes("GROUP BY domain, native_key")) {
        return { rows: ledgerNonInjective.map((entry) => ({ domain: entry.domain, native_key: entry.nativeKey })) };
      }
      if (config.text.includes("string_agg")) {
        // Round-4 P2: the ledger identity-set digest, computed entirely
        // server-side (one row per domain, never a per-identity row).
        // Default: no rows at all, matching every default fixture's
        // recordIdentities (readDomainPage's default fixture returns no
        // records for any domain, so recordIdentities is empty
        // everywhere by construction) -- both sides agree on null for
        // every domain unless a test explicitly supplies non-empty
        // identities on one or both sides.
        if (ledgerIdentitySets === undefined) return { rows: [] };
        return {
          rows: ledgerIdentitySets.map((entry) => ({
            domain: entry.domain,
            identity_set_sha256: entry.identitySha256s.length === 0
              ? null : createHash("sha256").update([...entry.identitySha256s].sort().join(""), "utf8").digest("hex"),
            record_set_sha256: entry.recordSha256s === undefined || entry.identitySha256s.length === 0
              ? null
              : createHash("sha256").update(
                entry.identitySha256s.map((identity, index) => [identity, entry.recordSha256s![index]!] as const)
                  .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                  .map(([identity, record]) => identity + record).join(""),
                "utf8",
              ).digest("hex"),
          })),
        };
      }
      if (config.text.includes("lcm.transfer_identities")) {
        if (overrides.ledgerIdentityTotal === null) return { rows: [] };
        return { rows: [{ count: String(ledgerIdentityTotal) }] };
      }
      if (config.text.includes("MAX(")) {
        const domain = Object.entries(SEQUENCE_BACKED_TABLES).find(([, table]) => config.text.includes(table))?.[0];
        const state = domain ? sequenceState[domain] : undefined;
        return { rows: [{ max_value: state?.maxValue ?? null }] };
      }
      if (config.text.includes("pg_get_serial_sequence")) {
        const table = config.values?.[0];
        const domain = Object.entries(SEQUENCE_BACKED_TABLES).find(([, value]) => value === table)?.[0];
        return { rows: [{ seq_name: domain ? seqNameFor(domain) : null }] };
      }
      if (config.text.includes("has_sequence_privilege")) {
        const seqName = config.values?.[0] as string | undefined;
        const domain = Object.keys(SEQUENCE_BACKED_TABLES).find((candidate) => seqNameFor(candidate) === seqName);
        const state = domain ? sequenceState[domain] : undefined;
        return { rows: [{ has_privilege: state?.privilegeDenied === true ? false : true }] };
      }
      if (config.text.includes("pg_catalog.pg_sequences")) {
        const seqName = config.values?.[0] as string | undefined;
        const domain = Object.keys(SEQUENCE_BACKED_TABLES).find((candidate) => seqNameFor(candidate) === seqName);
        const state = domain ? sequenceState[domain] : undefined;
        if (state === undefined || state.lastValue === null) return { rows: [] };
        return { rows: [{
          last_value: state.isCalled === false ? null : state.lastValue,
          start_value: state.startValue ?? state.lastValue,
          increment_by: state.incrementBy ?? "1",
        }] };
      }
      if (config.text.includes("pg_collation")) {
        // Fixed canned rows shared with fakeRuntime's own pg_collation
        // branch below, so the pre-window capture and the in-window
        // live-to-live re-read produce byte-identical digests by
        // construction on the default fixture -- overriding runtime.query
        // alone (or session.query alone) is how a test simulates real
        // window-drift.
        return { rows: [{ collname: "default", collcollate: "C", collctype: "C", collprovider: "c" }] };
      }
      if (config.text.includes("lcm.schema_migrations")) {
        // Round-4: mirrors fakeRuntime's own lcm.schema_migrations
        // branch, same reasoning as pg_collation above -- byte-identical
        // by construction on the default fixture, since the new
        // live-to-live migrations recheck now also runs on this session.
        return { rows: overrides.migrationsRows ?? FAKE_MIGRATIONS.map(({ id, sha256 }) => ({ id, checksum_sha256: sha256 })) };
      }
      if (config.text.includes("pg_control_system")) {
        // Round-4: mirrors fakeRuntime's own pg_control_system branch,
        // same reasoning -- the new live-to-live system_identifier
        // recheck now also runs on this session.
        return { rows: [{ system_identifier: overrides.systemIdentifier ?? "7123456789" }] };
      }
      return { rows: [{ admitted: true }] };
    }),
    close: vi.fn(async () => { /* fake */ }),
  };
}

function fakeRuntime(overrides: {
  session?: ReturnType<typeof fakeSession>;
  conversationsRows?: ReadonlyArray<Record<string, unknown>>;
  /** The portable-projection header rows (microsecond text); derived from conversationsRows when absent. */
  conversationHeaderRows?: ReadonlyArray<Record<string, unknown>>;
  searchRows?: ReadonlyArray<Record<string, unknown>>;
  transferRunId?: string | null;
  transferRunState?: string;
  // nativeKey is the raw locator format the copy actually writes
  // (json_build_array(id::text)::text, e.g. '["1"]' for a single-key
  // domain), never a bare id -- round-4 P1 found that comparing a bare
  // search-result id against this raw column directly was never true
  // on real data. The fake unwraps it the same way the production SQL
  // now does (::json->>0), so a fixture that hand-wrote a bare id here
  // could no longer silently agree with buggy production code.
  transferIdentities?: ReadonlyArray<{ identitySha256: string; nativeKey: string }>;
} = {}) {
  const session = overrides.session ?? fakeSession();
  // Default: one well-formed match, so the search self-match probe
  // reports ran: true (finds itself) on the default fixture, exactly
  // like the census/collation defaults elsewhere in this file assume a
  // sound destination unless a test overrides them. Shaped to satisfy
  // PostgreSqlLexicalSearchRepository's row decoding
  // (messageFromRow/decodeCombinedRows): match_phase 0 is "primary".
  const defaultSearchRows = overrides.searchRows ?? [{
    message_id: 1, conversation_id: 1, role: "user", snippet: "match",
    created_at: "2026-01-01T00:00:00.000Z", rank: 1, match_phase: 0,
  }];
  return {
    health: vi.fn(async () => ({ status: "healthy", backend: "postgresql", tls: true, serverMajorVersion: 18, serverEncoding: "UTF8" })),
    query: vi.fn(async (config: { text: string; values?: readonly unknown[] }) => {
      if (config.text.includes("lcm.conversations") && config.text.includes("to_char(")) {
        // The listing probe's identity read: the portable mapping's
        // microsecond projection, as text. Derived from the repository rows
        // (milliseconds padded to six digits) unless a test supplies finer ones.
        const microseconds = (value: unknown) => (typeof value === "string" ? value.replace(/[.](\d{3})Z$/u, ".$1000Z") : value);
        return {
          rows: overrides.conversationHeaderRows ?? (overrides.conversationsRows ?? []).map((row) => ({
            ...row, conversation_id: String(row.conversation_id),
            bootstrapped_at: microseconds(row.bootstrapped_at), created_at: microseconds(row.created_at),
            updated_at: microseconds(row.updated_at),
          })),
        };
      }
      if (config.text.includes("lcm.conversations")) return { rows: overrides.conversationsRows ?? [] };
      if (config.text.includes("lcm.schema_migrations")) {
        // Round-1 P2: migrationsSha256 now witnesses the destination's
        // own applied-migrations ledger rather than the compiled-in
        // bundle, so the fixture must serve rows shaped like that
        // table's columns -- matching FAKE_MIGRATIONS, which is what
        // EXPECTED_MIGRATIONS_SHA256 (baseInput's default
        // destinationMigrationsSha256) is derived from.
        return { rows: FAKE_MIGRATIONS.map(({ id, sha256 }) => ({ id, checksum_sha256: sha256 })) };
      }
      if (config.text.includes("pg_collation")) {
        return { rows: [{ collname: "default", collcollate: "C", collctype: "C", collprovider: "c" }] };
      }
      if (config.text.includes("lcm.transfer_runs")) {
        // Round-4 P1: the search probe's pre-window run_id lookup.
        // overrides.transferRunId === null simulates no completed run
        // existing at all (every candidate becomes unattributable
        // immediately); undefined (the default) provides a fixed run
        // id, matching the sound-destination default everywhere else
        // in this file. Round-4 P2: also returns state, defaulting to
        // "completed"; overrides.transferRunState models an
        // in-progress copy whose run exists but is not yet the final
        // ledger to correlate against.
        return overrides.transferRunId === null
          ? { rows: [] }
          : { rows: [{ run_id: overrides.transferRunId ?? "run-1", state: overrides.transferRunState ?? "completed" }] };
      }
      if (config.text.includes("lcm.transfer_identities")) {
        // Round-4 P1: the search probe's per-candidate identity-to-
        // native-key correlation. With no explicit mapping supplied,
        // every candidate correlates to native_key "1", matching
        // defaultSearchRows' message_id: 1 -- any candidate the default
        // fixture picks confirms a self-match, exactly like the
        // pre-round-4 "any non-empty result" default behaviour this
        // replaces. A supplied mapping models a real destination where
        // only specific identities were actually copied.
        if (overrides.transferIdentities !== undefined) {
          const identitySha256 = config.values?.[1];
          const match = overrides.transferIdentities.find((entry) => entry.identitySha256 === identitySha256);
          // Unwraps the raw locator the same way the production
          // query's ::json->>0 does, so the fixture's input format
          // matches what the copy actually writes rather than the
          // already-unwrapped value production expects.
          return { rows: match ? [{ native_key: (JSON.parse(match.nativeKey) as string[])[0] }] : [] };
        }
        return { rows: [{ native_key: "1" }] };
      }
      return { rows: [{ system_identifier: "7123456789" }] };
    }),
    transaction: vi.fn(async (callback: (executor: unknown) => Promise<unknown>) => callback({
      // Round-2 P1: the search self-match probe runs
      // PostgreSqlLexicalSearchRepository.searchMessages through
      // runtime.transaction, which itself issues a statement_timeout
      // read/write pair (withBoundedSearch) around the actual search
      // query -- all three must be routed distinctly, or the timeout
      // read fails validation before the search query ever runs.
      query: vi.fn(async (config: { text: string }) => {
        if (config.text.includes("current_setting('statement_timeout')")) return { rows: [{ previous_timeout: "0" }] };
        if (config.text.includes("set_config(")) return { rows: [] };
        if (config.text.includes("WITH input AS MATERIALIZED")) return { rows: defaultSearchRows };
        return { rows: [] };
      }),
    })),
    openReadOnlySnapshot: vi.fn(async () => session),
    close: vi.fn(async () => { /* fake */ }),
  };
}

function baseInput(overrides: Partial<VerifyMigrationGenerationInput> = {}): VerifyMigrationGenerationInput {
  return {
    generationId: "generation-1", targetGenerationId: "generation-1-postgresql", homeDir: "/home",
    expectedIdentity: identity(),
    destinationSettings: { url: "postgresql://runtime:secret@localhost/dest", caFile: "/ca.pem", poolMax: 2, connectionTimeoutMs: 1000, idleTimeoutMs: 1000, statementTimeoutMs: 1000 },
    expectedOwner: "lcm_test_migrator", ownerProcessId: "worker-1", scratchParent: "/scratch", leaseTtlMs: 60000,
    manifestRevision: 3, manifestChecksumSha256: HASH_A, destinationMigrationsSha256: EXPECTED_MIGRATIONS_SHA256,
    expectedDestinationIdentitySha256: HASH_A,
    expectedSystemIdentifier: "7123456789",
    projectMapWitnessSha256: HASH_A,
    queueClassificationWitness: { version: 1, queueCutoff: null, queueSetSha256: HASH_A, receiptSetSha256: HASH_A, epochChecksumSha256: HASH_A },
    sampleParameters: { version: 1, strideOrdinal: 97, sampleCount: 32, seedBasisSha256: HASH_A },
    ...overrides,
  };
}

function stubDestinationPrimitives(options: {
  domainCensus?: (domain: PortableDomain) => { domain: PortableDomain; recordCount: number; prefixSha256: string; terminalIdentitySha256: string | null };
  readDomainPage?: (domain: PortableDomain) => { predecessor: null; records: unknown[]; complete: boolean };
  identityFingerprintSha256?: string;
  manifestCheckpoints?: readonly ReturnType<typeof defaultLedgerCheckpoint>[];
} = {}) {
  vi.spyOn(coordination, "PostgreSqlWorkCoordinator").mockImplementation(function () { return ({
    assertLeaseFence: vi.fn(async () => ({})),
    acquireLease: vi.fn(async () => ({ fencingToken: 1n } as never)),
    releaseLease: vi.fn(async () => null),
  } as never); });
  vi.spyOn(searchConfiguration, "inspectPostgreSqlSearchConfiguration").mockResolvedValue({ actualSha256: REAL_SEARCH_CONFIGURATION_SHA256 } as never);
  vi.spyOn(portableSource, "readPostgreSqlPortableWitness").mockResolvedValue(HASH_A);
  vi.spyOn(portableDestination, "probePostgreSqlPortableDestination").mockResolvedValue({
    destinationWitnessSha256: HASH_A, identityFingerprintSha256: options.identityFingerprintSha256 ?? HASH_A,
    systemIdentifier: "7123456789", nonIdentityDomainsEmpty: true, existingRun: null,
  } as never);
  const manifestCheckpoints = options.manifestCheckpoints
    ?? PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => defaultLedgerCheckpoint(domain));
  const manifest = fakeManifestStore(manifestCheckpoints);
  const defaultReadDomainPage = () => ({ predecessor: null, records: [], complete: true });
  vi.spyOn(portableSource, "createPostgreSqlPortableSource").mockResolvedValue({
    close: vi.fn(async () => { /* fake */ }),
    readDomainPage: vi.fn(async (request: { domain: PortableDomain }) => (options.readDomainPage ?? defaultReadDomainPage)(request.domain)),
  } as never);
  const defaultCensus = (domain: PortableDomain) => ({
    domain, recordCount: PORTABLE_RECORD_DOMAIN_ORDER.indexOf(domain), prefixSha256: fakeHash(`prefix-${domain}-${PORTABLE_RECORD_DOMAIN_ORDER.indexOf(domain)}`),
    terminalIdentitySha256: PORTABLE_RECORD_DOMAIN_ORDER.indexOf(domain) === 0 ? null : HASH_A,
  });
  vi.spyOn(portableSource, "readPostgreSqlPortableSourceDomainCensus").mockImplementation(((_source: unknown, domain: PortableDomain) => (options.domainCensus ?? defaultCensus)(domain)) as never);
  return manifest;
}

function dependenciesFor(copySource: ReturnType<typeof fakeCopySource>, runtime: ReturnType<typeof fakeRuntime>, extra: Partial<VerifyMigrationGenerationDependencies> = {}): VerifyMigrationGenerationDependencies {
  return {
    openSource: vi.fn(async () => copySource) as never,
    createRuntime: vi.fn(() => runtime) as never,
    verifyTransferSchema: vi.fn(async () => ({}) as never),
    ...extra,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("assertPermanentReadOnlyGuard", () => {
  it("passes when the window session never assigns a transaction id", async () => {
    const session = fakeSession({ xid: null });
    await expect(assertPermanentReadOnlyGuard(session as never)).resolves.toBeUndefined();
  });
  it("refuses a session that assigned a transaction id", async () => {
    const session = fakeSession({ xid: "42" });
    await expect(assertPermanentReadOnlyGuard(session as never)).rejects.toThrow(MigrationVerificationDriverError);
  });
});

describe("readFencedDestinationCensus", () => {
  it("closes the created portable source but never the borrowed session", async () => {
    stubDestinationPrimitives();
    const session = fakeSession();
    const result = await readFencedDestinationCensus(session as never, {
      settings: baseInput().destinationSettings, expectedOwner: "owner", expectedIdentity: identity(), scratchParent: "/scratch",
    });
    expect(result.census).toHaveLength(PORTABLE_RECORD_DOMAIN_ORDER.length);
    expect(result.dependencyEdges.size).toBe(PORTABLE_RECORD_DOMAIN_ORDER.length);
    expect(result.recordIdentities.size).toBe(PORTABLE_RECORD_DOMAIN_ORDER.length);
    expect(session.close).not.toHaveBeenCalled();
  });
  it("closes the created portable source even when a domain read fails, without closing the borrowed session", async () => {
    stubDestinationPrimitives();
    vi.spyOn(portableSource, "readPostgreSqlPortableSourceDomainCensus").mockImplementation((() => { throw new Error("read-failure"); }) as never);
    const session = fakeSession();
    await expect(readFencedDestinationCensus(session as never, {
      settings: baseInput().destinationSettings, expectedOwner: "owner", expectedIdentity: identity(), scratchParent: "/scratch",
    })).rejects.toThrow("read-failure");
    expect(session.close).not.toHaveBeenCalled();
  });
  it("collects destination record identities and dependency edges from readDomainPage", async () => {
    const destinationRecord = {
      identitySha256: fakeHash("destination-child"),
      recordSha256: fakeHash("destination-child-record"),
      dependencies: [{ domain: "project", identitySha256: fakeHash("destination-parent") }],
    };
    stubDestinationPrimitives({
      readDomainPage: (domain) => ({
        predecessor: null,
        records: domain === "conversations" ? [destinationRecord] : [],
        complete: true,
      }),
    });
    const session = fakeSession();
    const result = await readFencedDestinationCensus(session as never, {
      settings: baseInput().destinationSettings, expectedOwner: "owner", expectedIdentity: identity(), scratchParent: "/scratch",
    });
    expect(result.recordIdentities.get("conversations")).toEqual(new Set([fakeHash("destination-child")]));
    expect(result.recordSha256s.get("conversations")).toEqual(
      new Map([[fakeHash("destination-child"), fakeHash("destination-child-record")]]),
    );
    expect(result.dependencyEdges.get("conversations")).toEqual(new Set([
      fakeHash("destination-child") + "|project|" + fakeHash("destination-parent"),
    ]));
  });
  it("pages through readDomainPage until complete, rather than stopping after the first page", async () => {
    let conversationsCalls = 0;
    vi.spyOn(coordination, "PostgreSqlWorkCoordinator").mockImplementation(function () { return ({
      assertLeaseFence: vi.fn(async () => ({})),
      acquireLease: vi.fn(async () => ({ fencingToken: 1n } as never)), releaseLease: vi.fn(async () => null),
    } as never); });
    vi.spyOn(searchConfiguration, "inspectPostgreSqlSearchConfiguration").mockResolvedValue({ actualSha256: REAL_SEARCH_CONFIGURATION_SHA256 } as never);
    vi.spyOn(portableSource, "readPostgreSqlPortableWitness").mockResolvedValue(HASH_A);
    vi.spyOn(portableSource, "readPostgreSqlPortableSourceDomainCensus").mockImplementation(((_s: unknown, domain: PortableDomain) => ({
      domain, recordCount: 2, prefixSha256: fakeHash("prefix-" + domain), terminalIdentitySha256: HASH_A,
    })) as never);
    vi.spyOn(portableSource, "createPostgreSqlPortableSource").mockResolvedValue({
      close: vi.fn(async () => { /* fake */ }),
      readDomainPage: vi.fn(async ({ domain, afterOrdinal }: { domain: PortableDomain; afterOrdinal: number }) => {
        if (domain !== "conversations") return { predecessor: null, records: [], complete: true };
        conversationsCalls += 1;
        if (afterOrdinal === 0) {
          return {
            predecessor: null,
            records: [{ identitySha256: fakeHash("page-1-child"), dependencies: [] }],
            complete: false,
          };
        }
        return {
          predecessor: null,
          records: [{ identitySha256: fakeHash("page-2-child"), dependencies: [] }],
          complete: true,
        };
      }),
    } as never);
    const session = fakeSession();
    const result = await readFencedDestinationCensus(session as never, {
      settings: baseInput().destinationSettings, expectedOwner: "owner", expectedIdentity: identity(), scratchParent: "/scratch",
    });
    expect(conversationsCalls).toBe(2);
    expect(result.recordIdentities.get("conversations")).toEqual(
      new Set([fakeHash("page-1-child"), fakeHash("page-2-child")]),
    );
  });
});

describe("reconcileDependencyEdges / readRelationDanglingReferenceMismatches", () => {
  it("catches a child remapped to a valid but wrong parent, which the dangling-reference guard alone cannot see", () => {
    // The #623 P1 shape: identity remapping points a child at a
    // different, otherwise perfectly valid, real parent record. Every
    // foreign-key constraint is satisfied and the parent genuinely
    // exists, so the cheap dangling check finds nothing here -- this is
    // exactly why edge-set equality, not dangling detection, has to be
    // the substantive half of the relation class.
    const sourceEdges = new Map<PortableDomain, ReadonlySet<string>>([
      ["messages", new Set(["msg-a|conversations|conv-correct"])],
    ]);
    const destinationEdges = new Map<PortableDomain, ReadonlySet<string>>([
      ["messages", new Set(["msg-a|conversations|conv-wrong"])],
    ]);
    const destinationIdentities = new Map<PortableDomain, ReadonlySet<string>>([
      ["conversations", new Set(["conv-correct", "conv-wrong"])],
    ]);

    const danglingOnly = readRelationDanglingReferenceMismatches(destinationEdges, destinationIdentities);
    expect(danglingOnly).toEqual([]);

    const edgeMismatches = reconcileDependencyEdges(sourceEdges, destinationEdges);
    expect(edgeMismatches).toEqual([{
      domain: "messages", class: "relation",
      identitySha256: migrationWitnessSha256(["relation-edge-mismatch-v1", "messages", "msg-a"]),
    }]);
  });
  it("passes when source and destination edge sets agree exactly", () => {
    const edges = new Map<PortableDomain, ReadonlySet<string>>([
      ["messages", new Set(["msg-a|conversations|conv-a", "msg-b|conversations|conv-a"])],
    ]);
    expect(reconcileDependencyEdges(edges, edges)).toEqual([]);
  });
  it("deduplicates two bad edges from the same child into a single mismatch", () => {
    const sourceEdges = new Map<PortableDomain, ReadonlySet<string>>([
      ["context-items", new Set(["ci-a|conversations|conv-x", "ci-a|messages|msg-x"])],
    ]);
    const destinationEdges = new Map<PortableDomain, ReadonlySet<string>>([
      ["context-items", new Set(["ci-a|conversations|conv-y", "ci-a|messages|msg-y"])],
    ]);
    const mismatches = reconcileDependencyEdges(sourceEdges, destinationEdges);
    expect(mismatches).toEqual([{
      domain: "context-items", class: "relation",
      identitySha256: migrationWitnessSha256(["relation-edge-mismatch-v1", "context-items", "ci-a"]),
    }]);
  });
  it("flags a destination edge whose referenced parent identity does not exist in the destination at all", () => {
    const destinationEdges = new Map<PortableDomain, ReadonlySet<string>>([
      ["messages", new Set(["msg-a|conversations|conv-missing"])],
    ]);
    const destinationIdentities = new Map<PortableDomain, ReadonlySet<string>>([
      ["conversations", new Set()],
    ]);
    const mismatches = readRelationDanglingReferenceMismatches(destinationEdges, destinationIdentities);
    expect(mismatches).toEqual([{
      domain: "messages", class: "relation",
      identitySha256: migrationWitnessSha256(["relation-dangling-reference-v1", "messages", "msg-a"]),
    }]);
  });
  it("passes the dangling guard when every referenced parent identity is present", () => {
    const destinationEdges = new Map<PortableDomain, ReadonlySet<string>>([
      ["messages", new Set(["msg-a|conversations|conv-a"])],
    ]);
    const destinationIdentities = new Map<PortableDomain, ReadonlySet<string>>([
      ["conversations", new Set(["conv-a"])],
    ]);
    expect(readRelationDanglingReferenceMismatches(destinationEdges, destinationIdentities)).toEqual([]);
  });
  it("deduplicates two dangling edges from the same child into a single mismatch", () => {
    const destinationEdges = new Map<PortableDomain, ReadonlySet<string>>([
      ["context-items", new Set(["ci-a|conversations|conv-missing", "ci-a|messages|msg-missing"])],
    ]);
    const destinationIdentities = new Map<PortableDomain, ReadonlySet<string>>([
      ["conversations", new Set()], ["messages", new Set()],
    ]);
    const mismatches = readRelationDanglingReferenceMismatches(destinationEdges, destinationIdentities);
    expect(mismatches).toEqual([{
      domain: "context-items", class: "relation",
      identitySha256: migrationWitnessSha256(["relation-dangling-reference-v1", "context-items", "ci-a"]),
    }]);
  });
  it("flags a dangling reference whose parent domain has no identity set at all, not only an empty one", () => {
    const destinationEdges = new Map<PortableDomain, ReadonlySet<string>>([
      ["messages", new Set(["msg-a|conversations|conv-a"])],
    ]);
    // "conversations" is entirely absent from the map, not present with
    // an empty set: proves the optional-chained lookup handles a missing
    // domain key the same as an empty one, rather than throwing.
    const destinationIdentities = new Map<PortableDomain, ReadonlySet<string>>();
    const mismatches = readRelationDanglingReferenceMismatches(destinationEdges, destinationIdentities);
    expect(mismatches).toEqual([{
      domain: "messages", class: "relation",
      identitySha256: migrationWitnessSha256(["relation-dangling-reference-v1", "messages", "msg-a"]),
    }]);
  });
});

describe("readLedgerMismatches", () => {
  function ledgerCensus() {
    return PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => ({
      domain, recordCount: PORTABLE_RECORD_DOMAIN_ORDER.indexOf(domain), prefixSha256: fakeHash("p-" + domain), terminalIdentitySha256: null,
    }));
  }
  function ledgerInput(overrides: {
    manifestCheckpoints?: readonly ReturnType<typeof defaultLedgerCheckpoint>[];
    census?: ReturnType<typeof ledgerCensus>;
    recordIdentities?: ReadonlyMap<PortableDomain, ReadonlySet<string>>;
    recordSha256s?: ReadonlyMap<PortableDomain, ReadonlyMap<string, string>>;
  } = {}) {
    return {
      projectId, targetGenerationId: "generation-1-postgresql",
      manifestSha256: HASH_A, identityFingerprintSha256: HASH_A,
      manifestCheckpoints: overrides.manifestCheckpoints ?? PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => defaultLedgerCheckpoint(domain)),
      census: overrides.census ?? ledgerCensus(),
      recordIdentities: overrides.recordIdentities ?? new Map(),
      recordSha256s: overrides.recordSha256s ?? new Map(),
    };
  }
  it("passes when the run, batches and identities all agree with the manifest and census", async () => {
    const session = fakeSession();
    const mismatches = await readLedgerMismatches(session as never, ledgerInput());
    expect(mismatches).toEqual([]);
  });
  it("flags a missing run row", async () => {
    const session = fakeSession({ ledgerRun: null });
    const mismatches = await readLedgerMismatches(session as never, ledgerInput());
    expect(mismatches).toEqual([{
      domain: "ledger", class: "ledger",
      identitySha256: migrationWitnessSha256(["ledger-run-mismatch-v1", "generation-1-postgresql"]),
    }]);
  });
  it("flags a run row whose state is not completed", async () => {
    const session = fakeSession({ ledgerRun: { state: "active", manifestSha256: HASH_A, projectSha256: HASH_A } });
    const mismatches = await readLedgerMismatches(session as never, ledgerInput());
    expect(mismatches).toEqual([{
      domain: "ledger", class: "ledger",
      identitySha256: migrationWitnessSha256(["ledger-run-mismatch-v1", "generation-1-postgresql"]),
    }]);
  });
  it("flags a run row whose project_sha256 disagrees with the destination probe identity fingerprint", async () => {
    const session = fakeSession({ ledgerRun: { state: "completed", manifestSha256: HASH_A, projectSha256: fakeHash("wrong-project") } });
    const mismatches = await readLedgerMismatches(session as never, ledgerInput());
    expect(mismatches).toEqual([{
      domain: "ledger", class: "ledger",
      identitySha256: migrationWitnessSha256(["ledger-run-mismatch-v1", "generation-1-postgresql"]),
    }]);
  });
  it("flags one domain whose terminal batch checkpoint does not match the manifest, without recomputing the checkpoint structure itself", async () => {
    const wrongCheckpoints = PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => (
      domain === "messages" ? { ...defaultLedgerCheckpoint(domain), sourceCheckpointSha256: fakeHash("stale-messages-checkpoint") } : defaultLedgerCheckpoint(domain)
    ));
    const session = fakeSession({ ledgerCheckpoints: wrongCheckpoints });
    const mismatches = await readLedgerMismatches(session as never, ledgerInput());
    expect(mismatches).toEqual([{
      domain: "messages", class: "ledger",
      identitySha256: migrationWitnessSha256(["ledger-batch-mismatch-v1", "messages"]),
    }]);
  });
  it("flags a domain missing its terminal batch entirely", async () => {
    const missingOneDomain = PORTABLE_RECORD_DOMAIN_ORDER
      .filter((domain) => domain !== "summaries")
      .map((domain) => defaultLedgerCheckpoint(domain));
    const session = fakeSession({ ledgerCheckpoints: missingOneDomain });
    const mismatches = await readLedgerMismatches(session as never, ledgerInput());
    expect(mismatches).toEqual([{
      domain: "summaries", class: "ledger",
      identitySha256: migrationWitnessSha256(["ledger-batch-mismatch-v1", "summaries"]),
    }]);
  });
  describe("transfer-batch chain (B5-2)", () => {
    const target = "messages" as const;
    const terminal = defaultLedgerCheckpoint(target);
    const terminalOrdinal = terminal.ordinal;
    const batchRow = (prior: string, checkpoint: string, first: number, next: number): LedgerBatchRowFixture => ({
      domain: target, prior_checkpoint_sha256: prior, checkpoint_sha256: checkpoint,
      first_ordinal: String(first), next_ordinal: String(next),
    });
    const otherDomainRows = (): LedgerBatchRowFixture[] => PORTABLE_RECORD_DOMAIN_ORDER
      .filter((domain) => domain !== target)
      .map((domain) => {
        const entry = defaultLedgerCheckpoint(domain);
        return {
          domain, prior_checkpoint_sha256: PORTABLE_INITIAL_CHECKPOINT_SHA256,
          checkpoint_sha256: entry.sourceCheckpointSha256, first_ordinal: "0", next_ordinal: String(entry.ordinal),
        };
      });
    const middle = fakeHash("chain-middle");
    const batchMismatch = {
      domain: target, class: "ledger",
      identitySha256: migrationWitnessSha256(["ledger-batch-mismatch-v1", target]),
    };
    async function read(targetRows: readonly LedgerBatchRowFixture[]) {
      const session = fakeSession({ ledgerBatchRows: [...otherDomainRows(), ...targetRows] });
      return readLedgerMismatches(session as never, ledgerInput());
    }
    it("passes a multi-batch chain from the initial prior, in any row order", async () => {
      const rows = [
        batchRow(PORTABLE_INITIAL_CHECKPOINT_SHA256, middle, 0, 1),
        batchRow(middle, terminal.sourceCheckpointSha256, 1, terminalOrdinal),
      ];
      expect(await read(rows)).toEqual([]);
      expect(await read([...rows].reverse())).toEqual([]);
    });
    it("reads every batch row of the run in a deterministic order", async () => {
      const session = fakeSession();
      await readLedgerMismatches(session as never, ledgerInput());
      const batchCall = session.query.mock.calls.find(([config]) => (
        (config as { text: string }).text.includes("FROM lcm.transfer_batches")
      ))![0] as { text: string };
      expect(batchCall.text).not.toContain("DISTINCT ON");
      expect(batchCall.text).toContain("ORDER BY domain, first_ordinal, next_ordinal, checkpoint_sha256");
    });
    it("flags a chain whose intermediate link is missing", async () => {
      expect(await read([
        batchRow(PORTABLE_INITIAL_CHECKPOINT_SHA256, middle, 0, 1),
        batchRow(fakeHash("absent-link"), terminal.sourceCheckpointSha256, 1, terminalOrdinal),
      ])).toEqual([batchMismatch]);
    });
    it("flags an orphan surplus row beside a valid chain", async () => {
      expect(await read([
        batchRow(fakeHash("orphan-prior"), fakeHash("orphan-checkpoint"), 0, 1),
        batchRow(PORTABLE_INITIAL_CHECKPOINT_SHA256, terminal.sourceCheckpointSha256, 0, terminalOrdinal),
      ])).toEqual([batchMismatch]);
    });
    it("flags a second chain reaching the same terminal ordinal", async () => {
      const otherMiddle = fakeHash("second-chain-middle");
      expect(await read([
        batchRow(fakeHash("second-prior"), otherMiddle, 0, 1),
        batchRow(otherMiddle, fakeHash("second-terminal"), 1, terminalOrdinal),
        batchRow(PORTABLE_INITIAL_CHECKPOINT_SHA256, terminal.sourceCheckpointSha256, 0, terminalOrdinal),
      ])).toEqual([batchMismatch]);
    });
    it("flags a chain that does not start at the initial prior", async () => {
      expect(await read([
        batchRow(fakeHash("not-initial"), terminal.sourceCheckpointSha256, 0, terminalOrdinal),
      ])).toEqual([batchMismatch]);
    });
    it("flags a chain whose first row does not start at ordinal 0", async () => {
      expect(await read([
        batchRow(PORTABLE_INITIAL_CHECKPOINT_SHA256, terminal.sourceCheckpointSha256, 1, terminalOrdinal),
      ])).toEqual([batchMismatch]);
    });
    it("flags a link whose first_ordinal is not the previous next_ordinal", async () => {
      expect(await read([
        batchRow(PORTABLE_INITIAL_CHECKPOINT_SHA256, middle, 0, 1),
        batchRow(middle, terminal.sourceCheckpointSha256, 2, terminalOrdinal),
      ])).toEqual([batchMismatch]);
    });
    it("flags a row set that loops back to an already walked prior", async () => {
      expect(await read([
        batchRow(PORTABLE_INITIAL_CHECKPOINT_SHA256, middle, 0, 1),
        batchRow(terminal.sourceCheckpointSha256, middle, terminalOrdinal, terminalOrdinal),
        batchRow(middle, terminal.sourceCheckpointSha256, 1, terminalOrdinal),
      ])).toEqual([batchMismatch]);
    });
    it("flags an initial zero-width batch that has a successor", async () => {
      const zeroWidth = fakeHash("initial-zero-width");
      expect(await read([
        batchRow(PORTABLE_INITIAL_CHECKPOINT_SHA256, zeroWidth, 0, 0),
        batchRow(zeroWidth, terminal.sourceCheckpointSha256, 0, terminalOrdinal),
      ])).toEqual([batchMismatch]);
    });
    it("flags an intermediate zero-width batch that has a successor", async () => {
      const zeroWidth = fakeHash("intermediate-zero-width");
      expect(await read([
        batchRow(PORTABLE_INITIAL_CHECKPOINT_SHA256, middle, 0, 1),
        batchRow(middle, zeroWidth, 1, 1),
        batchRow(zeroWidth, terminal.sourceCheckpointSha256, 1, terminalOrdinal),
      ])).toEqual([batchMismatch]);
    });
    it("passes a terminal zero-width batch that completes a nonempty prefix", async () => {
      expect(await read([
        batchRow(PORTABLE_INITIAL_CHECKPOINT_SHA256, middle, 0, terminalOrdinal),
        batchRow(middle, terminal.sourceCheckpointSha256, terminalOrdinal, terminalOrdinal),
      ])).toEqual([]);
    });
    it("passes a single zero-width batch for an empty domain", async () => {
      const [emptyDomain] = PORTABLE_RECORD_DOMAIN_ORDER;
      const emptyTerminal = defaultLedgerCheckpoint(emptyDomain!);
      expect(emptyTerminal.ordinal).toBe(0);
      const rows = [
        ...otherDomainRows().filter((row) => row.domain !== emptyDomain),
        ...(emptyDomain === target ? [] : [{
          domain: target, prior_checkpoint_sha256: PORTABLE_INITIAL_CHECKPOINT_SHA256,
          checkpoint_sha256: terminal.sourceCheckpointSha256, first_ordinal: "0", next_ordinal: String(terminalOrdinal),
        }]),
        {
          domain: emptyDomain!, prior_checkpoint_sha256: PORTABLE_INITIAL_CHECKPOINT_SHA256,
          checkpoint_sha256: emptyTerminal.sourceCheckpointSha256, first_ordinal: "0", next_ordinal: "0",
        },
      ];
      const session = fakeSession({ ledgerBatchRows: rows });
      expect(await readLedgerMismatches(session as never, ledgerInput())).toEqual([]);
    });
  });
  it("flags an identity cardinality mismatch against the census total", async () => {
    const session = fakeSession({ ledgerIdentityTotal: LEDGER_TOTAL_RECORD_COUNT_DEFAULT + 1 });
    const mismatches = await readLedgerMismatches(session as never, ledgerInput());
    expect(mismatches).toEqual([{
      domain: "ledger", class: "ledger",
      identitySha256: migrationWitnessSha256(["ledger-identity-cardinality-mismatch-v1", "generation-1-postgresql"]),
    }]);
  });
  it("fails closed when the identity count query returns no row at all", async () => {
    const session = fakeSession({ ledgerIdentityTotal: null });
    const mismatches = await readLedgerMismatches(session as never, ledgerInput());
    expect(mismatches).toEqual([{
      domain: "ledger", class: "ledger",
      identitySha256: migrationWitnessSha256(["ledger-identity-cardinality-mismatch-v1", "generation-1-postgresql"]),
    }]);
  });
  it("flags a non-injective native-key-to-identity mapping, the storage-level signature of the same defect the relation class catches", async () => {
    const session = fakeSession({ ledgerNonInjective: [{ domain: "messages", nativeKey: "native-key-a" }] });
    const mismatches = await readLedgerMismatches(session as never, ledgerInput());
    expect(mismatches).toEqual([{
      domain: "messages", class: "ledger",
      identitySha256: migrationWitnessSha256(["ledger-non-injective-mapping-v1", "messages", "native-key-a"]),
    }]);
  });
  it("passes when a domain's non-empty identity set agrees between the destination's own read and the ledger", async () => {
    // Proves the comparison is a real set check, not vacuously true
    // because both sides default to empty: both sides here carry the
    // same two identities for "messages", in different insertion order
    // (the comparison must sort, not compare positionally).
    const session = fakeSession({
      ledgerIdentitySets: [{ domain: "messages", identitySha256s: [fakeHash("m-a"), fakeHash("m-b")] }],
    });
    const mismatches = await readLedgerMismatches(session as never, ledgerInput({
      recordIdentities: new Map([["messages", new Set([fakeHash("m-b"), fakeHash("m-a")])]]),
    }));
    expect(mismatches).toEqual([]);
  });
  it("round-4 P2 red case: flags a substitution that preserves cardinality and injectivity but changes which identities were actually copied", async () => {
    // The exact defect cardinality-plus-injectivity cannot see: the
    // ledger's identity set for "messages" has the same size (2) and is
    // injective (two distinct native keys, two distinct identities), but
    // one of the two identities differs from what the destination's own
    // read actually contains -- a substitution, not a count or
    // uniqueness problem.
    const session = fakeSession({
      ledgerIdentitySets: [{ domain: "messages", identitySha256s: [fakeHash("m-a"), fakeHash("m-substituted")] }],
    });
    const mismatches = await readLedgerMismatches(session as never, ledgerInput({
      recordIdentities: new Map([["messages", new Set([fakeHash("m-a"), fakeHash("m-b")])]]),
    }));
    expect(mismatches).toEqual([{
      domain: "messages", class: "ledger",
      identitySha256: migrationWitnessSha256(["ledger-identity-set-mismatch-v1", "messages"]),
    }]);
  });
  it("passes when a domain's identity and record digests agree between the destination's own read and the ledger", async () => {
    // Both sides carry real, non-empty (identity, record) pairs in
    // different orders, so the comparison is a sorted fold on each side
    // rather than a vacuous null === null.
    const session = fakeSession({
      ledgerIdentitySets: [{
        domain: "messages", identitySha256s: [fakeHash("m-a"), fakeHash("m-b")],
        recordSha256s: [fakeHash("r-a"), fakeHash("r-b")],
      }],
    });
    const mismatches = await readLedgerMismatches(session as never, ledgerInput({
      recordIdentities: new Map([["messages", new Set([fakeHash("m-b"), fakeHash("m-a")])]]),
      recordSha256s: new Map([["messages", new Map([[fakeHash("m-b"), fakeHash("r-b")], [fakeHash("m-a"), fakeHash("r-a")]])]]),
    }));
    expect(mismatches).toEqual([]);
  });
  it("osW red case: flags a ledger record digest that was substituted while every identity, count and key still agree", async () => {
    // The identity-set check cannot see this: the same two identities are
    // recorded, one-to-one, and the destination holds the same two. Only
    // the record digest of one identity differs.
    const session = fakeSession({
      ledgerIdentitySets: [{
        domain: "messages", identitySha256s: [fakeHash("m-a"), fakeHash("m-b")],
        recordSha256s: [fakeHash("r-a"), fakeHash("r-substituted")],
      }],
    });
    const mismatches = await readLedgerMismatches(session as never, ledgerInput({
      recordIdentities: new Map([["messages", new Set([fakeHash("m-a"), fakeHash("m-b")])]]),
      recordSha256s: new Map([["messages", new Map([[fakeHash("m-a"), fakeHash("r-a")], [fakeHash("m-b"), fakeHash("r-b")]])]]),
    }));
    expect(mismatches).toEqual([{
      domain: "messages", class: "ledger",
      identitySha256: migrationWitnessSha256(["ledger-record-set-mismatch-v1", "messages"]),
    }]);
  });
  describe("a domain outside the portable order (kALxd, kBcQT)", () => {
    const unexpectedDomain = "unexpected-domain-canary";
    const unexpectedMismatch = {
      domain: "ledger", class: "ledger",
      identitySha256: migrationWitnessSha256(["ledger-unexpected-domain-v1", unexpectedDomain]),
    };
    it("records an extra transfer_batches domain instead of dropping it", async () => {
      const session = fakeSession({
        ledgerCheckpoints: [
          ...PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => defaultLedgerCheckpoint(domain)),
          { ...defaultLedgerCheckpoint("messages"), domain: unexpectedDomain as PortableDomain },
        ],
      });
      expect(await readLedgerMismatches(session as never, ledgerInput())).toEqual([unexpectedMismatch]);
    });
    it("records an unexpected transfer_identities domain instead of dropping it", async () => {
      const session = fakeSession({
        ledgerIdentitySets: [{ domain: unexpectedDomain, identitySha256s: [fakeHash("m-a")] }],
      });
      expect(await readLedgerMismatches(session as never, ledgerInput())).toEqual([unexpectedMismatch]);
    });
    it("records one mismatch when both queries return the same unexpected domain", async () => {
      const session = fakeSession({
        ledgerCheckpoints: [
          ...PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => defaultLedgerCheckpoint(domain)),
          { ...defaultLedgerCheckpoint("messages"), domain: unexpectedDomain as PortableDomain },
        ],
        ledgerIdentitySets: [{ domain: unexpectedDomain, identitySha256s: [fakeHash("m-a")] }],
      });
      expect(await readLedgerMismatches(session as never, ledgerInput())).toEqual([unexpectedMismatch]);
    });
    it("normalizes a non-injective mapping under an unexpected domain to the ledger pseudo-domain", async () => {
      const session = fakeSession({ ledgerNonInjective: [{ domain: unexpectedDomain, nativeKey: "native-key-a" }] });
      expect(await readLedgerMismatches(session as never, ledgerInput())).toEqual([{
        domain: "ledger", class: "ledger",
        identitySha256: migrationWitnessSha256(["ledger-non-injective-mapping-v1", unexpectedDomain, "native-key-a"]),
      }]);
    });
    it("builds a report with the mismatch and without the raw value instead of failing construction", async () => {
      stubDestinationPrimitives();
      const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
      const session = fakeSession({ ledgerNonInjective: [{ domain: unexpectedDomain, nativeKey: "native-key-a" }] });
      const result = await inspectMigrationVerification(
        baseInput({ homeDir: "/tmp/lcm-verify-unexpected-ledger-domain" }),
        dependenciesFor(fakeCopySource({ recordCounts }), fakeRuntime({ session })),
      );
      expect(result.activationEligible).toBe(false);
      expect(result.mismatches.some((mismatch) => mismatch.domain === "ledger" && mismatch.class === "ledger")).toBe(true);
      expect(JSON.stringify(result)).not.toContain(unexpectedDomain);
    }, 15000);
  });
});

describe("streamSourceCheckpoints: dependency edge capture", () => {
  it("captures every record's declared dependencies without a second source read", async () => {
    const dependentRecord = {
      ...fakeConversationRecord("2026-01-01T00:00:00.000000Z", "edge-capture-source"),
      dependencies: [{ domain: "project" as const, identitySha256: fakeHash("edge-capture-parent") }],
    };
    const stream = fakeStream({ conversations: 1 }, [dependentRecord]);
    const result = await streamSourceCheckpoints(stream as never);
    expect(result.dependencyEdges.size).toBe(PORTABLE_RECORD_DOMAIN_ORDER.length);
    expect(result.dependencyEdges.get("conversations")).toEqual(new Set([
      dependentRecord.identitySha256 + "|project|" + fakeHash("edge-capture-parent"),
    ]));
    // Every other domain's fake batch returns zero records (see
    // fakeStream), so their edge sets must stay empty without throwing.
    for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
      if (domain === "conversations") continue;
      expect(result.dependencyEdges.get(domain)).toEqual(new Set());
    }
  });
});

describe("sortMismatches", () => {
  it("reconcileCounts skips a destination domain absent from the source checkpoints", () => {
    const sourceCheckpoints = new Map([["machines", checkpoint("machines", 1, fakeHash("m"))] as const]);
    const destinationCensus = [
      { domain: "machines" as const, recordCount: 1, prefixSha256: fakeHash("m"), terminalIdentitySha256: HASH_A },
      { domain: "project" as const, recordCount: 0, prefixSha256: fakeHash("p"), terminalIdentitySha256: null },
    ];
    expect(reconcileCounts(sourceCheckpoints, destinationCensus)).toEqual([]);
  });

  it("streamSourceCheckpoints pages through multiple batches to reach completion", async () => {
    let calls = 0;
    const stream = {
      readBatch: vi.fn(async ({ domain }: { domain: PortableDomain }) => {
        calls += 1;
        const complete = calls > 1;
        return {
          version: 1, manifestSha256: HASH_A, domain, records: [], framedBytes: 0, complete,
          priorCheckpointSha256: null, checkpoint: checkpoint(domain, complete ? 2 : 1, fakeHash(`multi-${domain}-${calls}`)),
        };
      }),
      verify: vi.fn(), close: vi.fn(),
    };
    const { checkpoints } = await streamSourceCheckpoints(stream as never);
    expect(checkpoints.get("machines")?.recordCount).toBe(2);
    expect(stream.readBatch).toHaveBeenCalledTimes(PORTABLE_RECORD_DOMAIN_ORDER.length + 1);
  });

  it("streamSourceCheckpoints breaks a conversations createdAt tie by ascending identitySha256", async () => {
    const tiedRecord = (identitySha256: string) => ({
      ...fakeConversationRecord("2026-01-01T00:00:00.000000Z", identitySha256),
      identitySha256,
    });
    const low = tiedRecord("a".repeat(64));
    const high = tiedRecord("b".repeat(64));
    // Deliberately supplied out of the expected final order, so a passing
    // assertion proves the sort ran rather than merely preserved input order.
    const stream = fakeStream({}, [high, low]);
    const { conversationsPublicOrder } = await streamSourceCheckpoints(stream as never);
    expect(conversationsPublicOrder.map((entry) => entry.createdAt)).toEqual([
      "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
    ]);
  });

  it("streamSourceCheckpoints sorts conversations with distinct createdAt values that arrive out of order", async () => {
    const first = fakeConversationRecord("2026-01-01T00:00:00.000000Z", "first");
    const second = fakeConversationRecord("2026-01-02T00:00:00.000000Z", "second");
    const third = fakeConversationRecord("2026-01-03T00:00:00.000000Z", "third");
    // Reversed input forces the sort to actually reorder rather than confirm
    // an already-ascending array, exercising the createdAt "<" branch too.
    const stream = fakeStream({}, [third, second, first]);
    const { conversationsPublicOrder } = await streamSourceCheckpoints(stream as never);
    expect(conversationsPublicOrder.map((entry) => entry.createdAt)).toEqual([
      "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z",
    ]);
  });

  it("streamSourceCheckpoints breaks a createdAt tie by descending identitySha256 comparison order too", async () => {
    const tiedRecord = (identitySha256: string) => ({
      ...fakeConversationRecord("2026-01-01T00:00:00.000000Z", identitySha256),
      identitySha256,
    });
    const low = tiedRecord("a".repeat(64));
    const high = tiedRecord("b".repeat(64));
    // Already identity-ascending input: the comparator is invoked with the
    // higher identity first, exercising the ">" branch instead of "<".
    const stream = fakeStream({}, [low, high]);
    const { conversationsPublicOrder } = await streamSourceCheckpoints(stream as never);
    expect(conversationsPublicOrder.map((entry) => entry.createdAt)).toEqual([
      "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
    ]);
  });

  it("streamSourceCheckpoints treats two records with fully identical tie-break keys as equal", async () => {
    // Synthetic: real portable records never truly collide on identitySha256,
    // but the comparator must still return a total order for equal keys
    // (JS Array#sort requires a comparator, not merely a partial order).
    const duplicate = () => ({
      ...fakeConversationRecord("2026-01-01T00:00:00.000000Z", "same"),
      identitySha256: "c".repeat(64),
    });
    const stream = fakeStream({}, [duplicate(), duplicate()]);
    const { conversationsPublicOrder } = await streamSourceCheckpoints(stream as never);
    expect(conversationsPublicOrder.map((entry) => entry.createdAt)).toEqual([
      "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
    ]);
  });

  it("aggregates repeated (domain, class) mismatches into one total", async () => {
    const totals = totalsFor([
      { domain: "messages", class: "count", identitySha256: fakeHash("a") },
      { domain: "messages", class: "count", identitySha256: fakeHash("b") },
      { domain: "machines", class: "digest", identitySha256: fakeHash("c") },
    ]);
    expect(totals).toEqual(expect.arrayContaining([
      { domain: "messages", class: "count", count: 2 },
      { domain: "machines", class: "digest", count: 1 },
    ]));
  });

  it("orders by domain ordinal, then class, then identity digest", async () => {
    const order = [...PORTABLE_RECORD_DOMAIN_ORDER, "schema"] as const;
    const messagesCountIdentities = [fakeHash("a"), fakeHash("z")].sort();
    const unsorted = [
      { domain: "messages" as const, class: "relation" as const, identitySha256: fakeHash("b") },
      { domain: "messages" as const, class: "count" as const, identitySha256: messagesCountIdentities[1]! },
      { domain: "messages" as const, class: "count" as const, identitySha256: messagesCountIdentities[0]! },
      { domain: "machines" as const, class: "count" as const, identitySha256: fakeHash("y") },
    ];
    const sorted = sortMismatches(unsorted, order);
    expect(sorted.map((m) => [m.domain, m.class, m.identitySha256])).toEqual([
      ["machines", "count", fakeHash("y")],
      ["messages", "count", messagesCountIdentities[0]!],
      ["messages", "count", messagesCountIdentities[1]!],
      ["messages", "relation", fakeHash("b")],
    ]);
  });
  it("directly compares two entries that differ only by class within the same domain", () => {
    const order = [...PORTABLE_RECORD_DOMAIN_ORDER, "schema"] as const;
    const countFirst = sortMismatches([
      { domain: "messages" as const, class: "relation" as const, identitySha256: fakeHash("b") },
      { domain: "messages" as const, class: "count" as const, identitySha256: fakeHash("a") },
    ], order);
    expect(countFirst.map((m) => m.class)).toEqual(["count", "relation"]);
    const relationFirst = sortMismatches([
      { domain: "messages" as const, class: "count" as const, identitySha256: fakeHash("a") },
      { domain: "messages" as const, class: "relation" as const, identitySha256: fakeHash("b") },
    ], order);
    expect(relationFirst.map((m) => m.class)).toEqual(["count", "relation"]);
  });
  it("directly compares two entries that differ only by identity digest within the same (domain, class)", () => {
    const order = [...PORTABLE_RECORD_DOMAIN_ORDER, "schema"] as const;
    const [low, high] = [fakeHash("a"), fakeHash("z")].sort();
    const ascending = sortMismatches([
      { domain: "messages" as const, class: "count" as const, identitySha256: high! },
      { domain: "messages" as const, class: "count" as const, identitySha256: low! },
    ], order);
    expect(ascending.map((m) => m.identitySha256)).toEqual([low, high]);
    const alreadyAscending = sortMismatches([
      { domain: "messages" as const, class: "count" as const, identitySha256: low! },
      { domain: "messages" as const, class: "count" as const, identitySha256: high! },
    ], order);
    expect(alreadyAscending.map((m) => m.identitySha256)).toEqual([low, high]);
  });
  it("treats two entries with an identical identity digest as equal", () => {
    const order = [...PORTABLE_RECORD_DOMAIN_ORDER, "schema"] as const;
    const same = fakeHash("same");
    const equal = sortMismatches([
      { domain: "messages" as const, class: "count" as const, identitySha256: same },
      { domain: "messages" as const, class: "count" as const, identitySha256: same },
    ], order);
    expect(equal.map((m) => m.identitySha256)).toEqual([same, same]);
  });
  it("sortMismatchTotals: round-2 P3 -- orders two totals that differ only by class within the same domain, without borrowing sortMismatches' identity tie-break", () => {
    // The dedicated sorter this replaced an `as unknown as` cast with:
    // MigrationVerificationMismatchTotal has no identitySha256 field at
    // all, so this test only exercises the two fields the sorter
    // actually has -- domain and class -- and is the only place that
    // exercises the "same domain" branch of sortMismatchTotals directly
    // (the double-cast version relied on sortMismatches' third
    // comparator key silently reading undefined off every total, which
    // this dedicated sorter no longer has to be trusted about).
    const order = [...PORTABLE_RECORD_DOMAIN_ORDER, "schema", "ledger"] as const;
    const ledgerFirst = sortMismatchTotals([
      { domain: "messages" as const, class: "ledger" as const, count: 1 },
      { domain: "messages" as const, class: "relation" as const, count: 1 },
    ], order);
    expect(ledgerFirst.map((total) => total.class)).toEqual(["relation", "ledger"]);
    const relationFirst = sortMismatchTotals([
      { domain: "messages" as const, class: "relation" as const, count: 1 },
      { domain: "messages" as const, class: "ledger" as const, count: 1 },
    ], order);
    expect(relationFirst.map((total) => total.class)).toEqual(["relation", "ledger"]);
  });
  it("sortMismatchTotals: orders two totals by domain when their classes differ too", () => {
    const order = [...PORTABLE_RECORD_DOMAIN_ORDER, "schema", "ledger"] as const;
    const sorted = sortMismatchTotals([
      { domain: "messages" as const, class: "ledger" as const, count: 1 },
      { domain: "conversations" as const, class: "count" as const, count: 2 },
    ], order);
    expect(sorted.map((total) => total.domain)).toEqual(["conversations", "messages"]);
  });
  it("round-1 P1 red case: orders relation before ledger within one domain, per the frozen class ordinal, not lexicographically", () => {
    // "ledger" < "relation" lexicographically, but the frozen
    // MIGRATION_MISMATCH_CLASSES ordinal places relation (index 3) before
    // ledger (index 6). Every existing sort test before this one mixed
    // only class pairs whose two orderings happen to agree; this pairing
    // is the one that actually breaks under a lexicographic comparison.
    const order = [...PORTABLE_RECORD_DOMAIN_ORDER, "schema", "ledger"] as const;
    const sorted = sortMismatches([
      { domain: "messages" as const, class: "ledger" as const, identitySha256: fakeHash("ledger-mismatch") },
      { domain: "messages" as const, class: "relation" as const, identitySha256: fakeHash("relation-mismatch") },
    ], order);
    expect(sorted.map((m) => m.class)).toEqual(["relation", "ledger"]);
  });
  it("round-1 P1 red case: a same-domain relation-plus-ledger mismatch pair, sorted by this driver, constructs a report body without throwing", () => {
    // The defect this closes: the driver's own sortMismatches output was
    // fed straight into createMigrationVerificationReport as "already
    // sorted", but its lexicographic class order disagreed with the
    // report body's own construction-time validator, which enforces the
    // frozen ordinal via assertSortedUnique. A domain carrying both
    // classes therefore threw invalid-input at construction and no
    // report was ever persisted for exactly the badly diverged
    // destination the operator-evidence path exists to serve. This test
    // goes through the real report-body constructor, not just the sort
    // function in isolation.
    const order = [...PORTABLE_RECORD_DOMAIN_ORDER, "schema", "ledger", "public-listing"] as const;
    const mismatches = sortMismatches([
      { domain: "messages" as const, class: "ledger" as const, identitySha256: fakeHash("ledger-mismatch") },
      { domain: "messages" as const, class: "relation" as const, identitySha256: fakeHash("relation-mismatch") },
    ], order);
    const mismatchTotals = sortMismatches(
      totalsFor(mismatches) as unknown as typeof mismatches, order,
    ).map((total) => ({ domain: total.domain, class: total.class, count: 1 }));
    const domainVector = <T>(build: (domain: PortableDomain, index: number) => T): T[] => PORTABLE_RECORD_DOMAIN_ORDER.map(build);
    expect(() => createMigrationVerificationReportBody({
      generationId: "generation-1", targetGenerationId: "generation-1-postgresql",
      bindingSha256: HASH_A, manifestRevision: 1, manifestChecksumSha256: HASH_A,
      sourceWitness: { version: 1, identitySha256: HASH_A, schemaSha256: HASH_A, contentSha256: HASH_A },
      destinationIdentity: { version: 1, sealedWitnessSha256: HASH_A, systemIdentifier: "712345" },
      destinationSchemaWitness: {
        version: 1, migrationsSha256: HASH_A, searchConfigurationSha256: HASH_A,
        collationSha256: HASH_A, sequenceStateSha256: HASH_A,
      },
      projectMapWitnessSha256: HASH_A,
      queueClassificationWitness: {
        version: 1, queueCutoff: null, queueSetSha256: HASH_A, receiptSetSha256: HASH_A, epochChecksumSha256: HASH_A,
      },
      censusVector: {
        version: 1,
        domains: domainVector((domain, index) => ({ domain, recordCount: index, prefixSha256: fakeHash("c" + domain) })),
        contentSha256: HASH_A,
      },
      canonicalDelta: {
        version: 1,
        domains: domainVector((domain, index) => ({ domain, recordCount: index, terminalIdentitySha256: fakeHash("d" + domain) })),
      },
      classCoverage: MIGRATION_MISMATCH_CLASSES.map((mismatchClass) => ({ class: mismatchClass, ran: true })),
      publicProbeSha256: HASH_A,
      publicProbeCoverage: MIGRATION_PUBLIC_PROBE_ORDER.map((probe) => ({ probe, ran: true })),
      sampleParameters: { version: 1, strideOrdinal: 97, sampleCount: 32, seedBasisSha256: HASH_A },
      mismatches, mismatchTotals,
    })).not.toThrow();
  });
});

describe("verifyMigrationGeneration", () => {
  it("produces a clean report when source and destination agree on every domain", async () => {
    stubDestinationPrimitives();
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const copySource = fakeCopySource({ recordCounts });
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(copySource, runtime);
    const result = await verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-clean" }), dependencies);
    expect(result.outcome).toBe("clean");
    expect(result.report.mismatches).toEqual([]);
    // Every reconciliation class this driver defines is now implemented
    // (relation and ledger were the last two), so a genuinely clean report
    // against a sound fixture is activation-eligible for the first time --
    // this is the milestone the class-coverage gate existed to protect
    // until it was actually reached, not a relaxation of the gate itself.
    expect(result.report.activationEligible).toBe(true);
    expect(result.report.body.classCoverage).toEqual([
      { class: "count", ran: true },
      { class: "digest", ran: true },
      { class: "identity", ran: true },
      { class: "relation", ran: true },
      { class: "sequence", ran: true },
      { class: "schema", ran: true },
      { class: "ledger", ran: true },
      { class: "sample", ran: true },
    ]);
    expect(result.report.body.publicProbeCoverage).toEqual([
      { probe: "public-listing", ran: true },
      { probe: "public-search", ran: true },
    ]);
    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(copySource.stream.close).toHaveBeenCalledTimes(1);
  }, 15000);

  it("produces a digest-class mismatch when record counts agree but content diverges", async () => {
    stubDestinationPrimitives({
      domainCensus: (domain) => ({ domain, recordCount: 3, prefixSha256: fakeHash(`digest-mismatch-${domain}`), terminalIdentitySha256: HASH_A }),
    });
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => [domain, 3])) as Partial<Record<PortableDomain, number>>;
    const copySource = fakeCopySource({ recordCounts });
    const runtime = fakeRuntime({ session: fakeSession({ ledgerIdentityTotal: 3 * PORTABLE_RECORD_DOMAIN_ORDER.length }) });
    const dependencies = dependenciesFor(copySource, runtime);
    const result = await verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-digest" }), dependencies);
    expect(result.outcome).toBe("mismatches");
    expect(result.report.mismatches.every((mismatch) => mismatch.class === "digest")).toBe(true);
  }, 15000);

  it("produces a mismatches report when a destination domain diverges from the source", async () => {
    stubDestinationPrimitives({
      domainCensus: (domain) => ({ domain, recordCount: 99, prefixSha256: fakeHash(`wrong-${domain}`), terminalIdentitySha256: HASH_A }),
    });
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => [domain, 1])) as Partial<Record<PortableDomain, number>>;
    const copySource = fakeCopySource({ recordCounts });
    const runtime = fakeRuntime({ session: fakeSession({ ledgerIdentityTotal: 99 * PORTABLE_RECORD_DOMAIN_ORDER.length }) });
    const dependencies = dependenciesFor(copySource, runtime);
    const result = await verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-dirty" }), dependencies);
    expect(result.outcome).toBe("mismatches");
    expect(result.report.mismatches.length).toBeGreaterThan(0);
    expect(result.report.mismatches.every((mismatch) => mismatch.class === "count")).toBe(true);
  }, 15000);

  it("refuses when the destination migrations chain does not match the expected witness", async () => {
    stubDestinationPrimitives();
    const copySource = fakeCopySource();
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(copySource, runtime);
    await expect(verifyMigrationGeneration(
      baseInput({ homeDir: "/tmp/lcm-verify-drift", destinationMigrationsSha256: "b".repeat(64) }),
      dependencies,
    )).rejects.toMatchObject({ reason: "destination-drift" });
    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(copySource.stream.close).toHaveBeenCalledTimes(1);
  });

  it("round-1 P2 red case: refuses when the destination's own applied-migrations table disagrees with the expected witness, even though the compiled-in migration bundle would agree", async () => {
    // migrationsSha256 must witness what lcm.schema_migrations actually
    // records on the destination, not what the currently running
    // binary's migration bundle happens to contain. Here the live table
    // disagrees with the expected witness while the compiled-in bundle
    // (FAKE_MIGRATIONS, matching EXPECTED_MIGRATIONS_SHA256) would have
    // agreed with it -- so a driver that read the bundle instead of the
    // live table would wrongly certify a destination whose real applied
    // migrations do not match what is expected.
    stubDestinationPrimitives();
    const copySource = fakeCopySource();
    const runtime = fakeRuntime();
    const originalRuntimeQuery = runtime.query;
    runtime.query = vi.fn(async (config: { text: string }) => {
      if (config.text.includes("lcm.schema_migrations")) {
        return { rows: [{ id: "0001", checksum_sha256: fakeHash("drifted-migration-checksum") }] };
      }
      return originalRuntimeQuery(config as never);
    }) as never;
    const dependencies = dependenciesFor(copySource, runtime);
    await expect(verifyMigrationGeneration(
      baseInput({ homeDir: "/tmp/lcm-verify-live-migrations-drift", destinationMigrationsSha256: EXPECTED_MIGRATIONS_SHA256 }),
      dependencies,
    )).rejects.toMatchObject({ reason: "destination-drift" });
  });

  it("round-1 P1 red case: refuses when the destination search configuration changes inside the fenced window (v3.2 live-to-live)", async () => {
    // W4: search-configuration/collation were previously captured once
    // and never compared to anything -- recorded, not evidence. Frozen
    // witness-schema v3.2's audit table requires them compared live-to-
    // live; there is no manifest-sealed baseline the way there is for
    // migrations, so the comparison is the value captured before the
    // window against a second read taken from inside it.
    stubDestinationPrimitives();
    vi.spyOn(searchConfiguration, "inspectPostgreSqlSearchConfiguration")
      .mockResolvedValueOnce({ actualSha256: REAL_SEARCH_CONFIGURATION_SHA256 } as never)
      .mockResolvedValueOnce({ actualSha256: fakeHash("drifted-search-configuration") } as never);
    const copySource = fakeCopySource();
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(copySource, runtime);
    await expect(verifyMigrationGeneration(
      baseInput({ homeDir: "/tmp/lcm-verify-search-config-window-drift" }), dependencies,
    )).rejects.toMatchObject({ reason: "destination-drift" });
  }, 15000);

  it("refuses when the destination search configuration becomes absent inside the fenced window", async () => {
    stubDestinationPrimitives();
    vi.spyOn(searchConfiguration, "inspectPostgreSqlSearchConfiguration")
      .mockResolvedValueOnce({ actualSha256: REAL_SEARCH_CONFIGURATION_SHA256 } as never)
      .mockResolvedValueOnce({ actualSha256: null } as never);
    const copySource = fakeCopySource();
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(copySource, runtime);
    await expect(verifyMigrationGeneration(
      baseInput({ homeDir: "/tmp/lcm-verify-search-config-window-absent" }), dependencies,
    )).rejects.toThrow(MigrationVerificationDriverError);
  }, 15000);

  it("round-1 P1 red case: refuses when the destination collation changes inside the fenced window (v3.2 live-to-live)", async () => {
    stubDestinationPrimitives();
    const copySource = fakeCopySource();
    // Pre-window capture (via runtime.query) and the in-window re-read
    // (via session.query) deliberately disagree on collation, simulating
    // an admin changing it mid-verification -- exactly the drift the
    // census's row-level comparison cannot see.
    const driftedSession = fakeSession();
    const originalSessionQuery = driftedSession.query;
    driftedSession.query = vi.fn(async (config: { text: string; values?: readonly unknown[] }) => {
      if (config.text.includes("pg_collation")) {
        return { rows: [{ collname: "drifted", collcollate: "en_US.UTF-8", collctype: "en_US.UTF-8", collprovider: "c" }] };
      }
      return originalSessionQuery(config);
    }) as never;
    const runtime = fakeRuntime({ session: driftedSession });
    const dependencies = dependenciesFor(copySource, runtime);
    await expect(verifyMigrationGeneration(
      baseInput({ homeDir: "/tmp/lcm-verify-collation-window-drift" }), dependencies,
    )).rejects.toMatchObject({ reason: "destination-drift" });
  }, 15000);

  it("round-4 red case: refuses when the destination migrations chain changes inside the fenced window (live-to-live)", async () => {
    // Pre-window capture (via runtime.query, step 2) and the in-window
    // re-read (via session.query, assertSchemaWitnessLiveToLive) are
    // deliberately made to disagree here -- both agreeing with the
    // *expected* destinationMigrationsSha256 individually would not be
    // enough, since the interval this check closes is exactly the one
    // between the pre-lease read and the window opening, where a
    // migration could commit in between. The default runtime still
    // reports FAKE_MIGRATIONS (matching EXPECTED_MIGRATIONS_SHA256, the
    // pre-window comparison target), so only the in-window session read
    // is drifted -- a driver that reused the pre-window value instead of
    // rereading it live would wrongly pass this case.
    stubDestinationPrimitives();
    const copySource = fakeCopySource();
    const driftedSession = fakeSession({
      migrationsRows: [{ id: "0001", checksum_sha256: fakeHash("drifted-migration-checksum") }],
    });
    const runtime = fakeRuntime({ session: driftedSession });
    const dependencies = dependenciesFor(copySource, runtime);
    await expect(verifyMigrationGeneration(
      baseInput({ homeDir: "/tmp/lcm-verify-live-migrations-window-drift", destinationMigrationsSha256: EXPECTED_MIGRATIONS_SHA256 }),
      dependencies,
    )).rejects.toMatchObject({ reason: "destination-drift" });
  }, 15000);

  it("round-4 red case: refuses when the destination system identifier changes inside the fenced window (live-to-live)", async () => {
    // Same shape as the migrations-chain case above, but for
    // system_identifier: the pre-window read (captureDestinationIdentity,
    // via runtime.query) still agrees with expectedSystemIdentifier, and
    // only the in-window session read disagrees, simulating a failover
    // landing in the interval between the pre-lease read and the window
    // actually opening -- the interval assertSchemaWitnessLiveToLive's
    // own docstring names but which, before round-4, nothing checked.
    stubDestinationPrimitives();
    const copySource = fakeCopySource();
    const driftedSession = fakeSession({ systemIdentifier: "9999999999" });
    const runtime = fakeRuntime({ session: driftedSession });
    const dependencies = dependenciesFor(copySource, runtime);
    await expect(verifyMigrationGeneration(
      baseInput({ homeDir: "/tmp/lcm-verify-live-system-identifier-window-drift", expectedSystemIdentifier: "7123456789" }),
      dependencies,
    )).rejects.toMatchObject({ reason: "destination-drift" });
  }, 15000);

  it("refuses when the verification lease is already held", async () => {
    vi.spyOn(coordination, "PostgreSqlWorkCoordinator").mockImplementation(function () { return ({
      assertLeaseFence: vi.fn(async () => ({})),
      acquireLease: vi.fn(async () => null),
      releaseLease: vi.fn(async () => null),
    } as never); });
    vi.spyOn(searchConfiguration, "inspectPostgreSqlSearchConfiguration").mockResolvedValue({ actualSha256: REAL_SEARCH_CONFIGURATION_SHA256 } as never);
    vi.spyOn(portableSource, "readPostgreSqlPortableWitness").mockResolvedValue(HASH_A);
    vi.spyOn(portableDestination, "probePostgreSqlPortableDestination").mockResolvedValue({
      destinationWitnessSha256: HASH_A, identityFingerprintSha256: HASH_A, nonIdentityDomainsEmpty: true, existingRun: null,
    } as never);
    fakeManifestStore();
    const copySource = fakeCopySource();
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(copySource, runtime);
    await expect(verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-lease" }), dependencies))
      .rejects.toMatchObject({ reason: "lease-unavailable" });
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  it("refuses when the destination search configuration is absent", async () => {
    vi.spyOn(coordination, "PostgreSqlWorkCoordinator").mockImplementation(function () { return ({
      assertLeaseFence: vi.fn(async () => ({})),
      acquireLease: vi.fn(async () => ({ fencingToken: 1n } as never)), releaseLease: vi.fn(async () => null),
    } as never); });
    vi.spyOn(searchConfiguration, "inspectPostgreSqlSearchConfiguration")
      .mockResolvedValue({ actualSha256: null, objectCount: 0, ownershipReady: false } as never);
    vi.spyOn(portableSource, "readPostgreSqlPortableWitness").mockResolvedValue(HASH_A);
    const copySource = fakeCopySource();
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(copySource, runtime);
    await expect(verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-search" }), dependencies))
      .rejects.toMatchObject({ reason: "invalid-input", message: "destination search configuration is absent" });
  });

  it("round-3 P2 red case: refuses a stable-but-wrong search configuration digest, never comparing only to itself", async () => {
    // Distinct from the live-to-live drift test above: this value never
    // changes between the pre-window and in-window reads, so a
    // comparison against only itself (the live-to-live mechanism alone)
    // would pass cleanly. A non-null, well-formed, *stable* digest that
    // simply is not the one this driver's own build expects -- an
    // installer from a different revision, or a hand-edited
    // configuration that happens to be internally consistent -- must
    // still refuse, by pinning the pre-window read against the
    // compiled-in POSTGRESQL_SEARCH_CONFIGURATION_SHA256 rather than
    // only against a second read of itself.
    vi.spyOn(coordination, "PostgreSqlWorkCoordinator").mockImplementation(function () { return ({
      assertLeaseFence: vi.fn(async () => ({})),
      acquireLease: vi.fn(async () => ({ fencingToken: 1n } as never)), releaseLease: vi.fn(async () => null),
    } as never); });
    vi.spyOn(searchConfiguration, "inspectPostgreSqlSearchConfiguration")
      .mockResolvedValue({ actualSha256: fakeHash("stable-wrong-search-configuration"), objectCount: 19, ownershipReady: true } as never);
    vi.spyOn(portableSource, "readPostgreSqlPortableWitness").mockResolvedValue(HASH_A);
    const copySource = fakeCopySource();
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(copySource, runtime);
    await expect(verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-search-stable-wrong" }), dependencies))
      .rejects.toMatchObject({
        reason: "invalid-input",
        message: "destination search configuration digest does not match the pinned lcm.search_v1 contract",
      });
  });

  it("round-1 P3: distinguishes a present-but-malformed search configuration from a genuinely absent one", async () => {
    // objectCount > 0 means the configuration/function objects exist but
    // fail the ownership or definition contract -- a different failure
    // an operator would investigate differently than "never created".
    // v3.4's unattributable-NULL shape: a NULL actualSha256 alone does
    // not say which of the two happened.
    vi.spyOn(coordination, "PostgreSqlWorkCoordinator").mockImplementation(function () { return ({
      assertLeaseFence: vi.fn(async () => ({})),
      acquireLease: vi.fn(async () => ({ fencingToken: 1n } as never)), releaseLease: vi.fn(async () => null),
    } as never); });
    vi.spyOn(searchConfiguration, "inspectPostgreSqlSearchConfiguration")
      .mockResolvedValue({ actualSha256: null, objectCount: 1, ownershipReady: false } as never);
    vi.spyOn(portableSource, "readPostgreSqlPortableWitness").mockResolvedValue(HASH_A);
    const copySource = fakeCopySource();
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(copySource, runtime);
    await expect(verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-search-malformed" }), dependencies))
      .rejects.toMatchObject({
        reason: "invalid-input",
        message: expect.stringContaining("does not satisfy its ownership or definition contract"),
      });
  });

  it("refuses when the destination system identifier is malformed", async () => {
    vi.spyOn(coordination, "PostgreSqlWorkCoordinator").mockImplementation(function () { return ({
      assertLeaseFence: vi.fn(async () => ({})),
      acquireLease: vi.fn(async () => ({ fencingToken: 1n } as never)), releaseLease: vi.fn(async () => null),
    } as never); });
    vi.spyOn(searchConfiguration, "inspectPostgreSqlSearchConfiguration").mockResolvedValue({ actualSha256: REAL_SEARCH_CONFIGURATION_SHA256 } as never);
    vi.spyOn(portableSource, "readPostgreSqlPortableWitness").mockResolvedValue(HASH_A);
    const copySource = fakeCopySource();
    const badRuntime = fakeRuntime();
    // Only the system-identifier query returns the malformed value;
    // everything else (schema_migrations, collation) must still answer
    // normally, or this refuses for the wrong reason before the
    // system-identifier check is ever reached.
    const originalBadRuntimeQuery = badRuntime.query;
    badRuntime.query = vi.fn(async (config: { text: string }) => {
      if (config.text.includes("pg_control_system")) return { rows: [{ system_identifier: "not-a-number" }] };
      return originalBadRuntimeQuery(config as never);
    }) as never;
    const dependencies = dependenciesFor(copySource, badRuntime);
    await expect(verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-sysid" }), dependencies))
      .rejects.toThrow(MigrationVerificationDriverError);
  });

  it("never internally retries: a connection loss propagates, and a fresh call restarts the whole pass from scratch", async () => {
    stubDestinationPrimitives();
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    let attempt = 0;
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(fakeCopySource({ recordCounts }), runtime, {
      openSource: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("connection-lost-canary");
        return fakeCopySource({ recordCounts });
      }) as never,
    });
    const input = baseInput({ homeDir: "/tmp/lcm-verify-restart" });
    await expect(verifyMigrationGeneration(input, dependencies)).rejects.toThrow("connection-lost-canary");
    // The failed attempt must not have touched the destination runtime or lease at all.
    expect(runtime.openReadOnlySnapshot).not.toHaveBeenCalled();
    // A fresh call is a complete, independent pass: it re-opens the source
    // and completes normally, proving no partial state survived the failure.
    const result = await verifyMigrationGeneration(input, dependencies);
    expect(attempt).toBe(2);
    expect(result.outcome).toBe("clean");
  }, 15000);

  it("still releases the lease when the census window fails", async () => {
    stubDestinationPrimitives();
    const session = fakeSession();
    session.query = vi.fn(async () => { throw new Error("window-failure-canary"); }) as never;
    const runtime = fakeRuntime({ session });
    let released = false;
    vi.spyOn(coordination, "PostgreSqlWorkCoordinator").mockImplementation(function () { return ({
      assertLeaseFence: vi.fn(async () => ({})),
      acquireLease: vi.fn(async () => ({ fencingToken: 1n } as never)),
      releaseLease: vi.fn(async () => { released = true; return null; }),
    } as never); });
    const copySource = fakeCopySource();
    const dependencies = dependenciesFor(copySource, runtime);
    await expect(verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-window-fail" }), dependencies))
      .rejects.toThrow("window-failure-canary");
    expect(released).toBe(true);
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("round-4 P1: a window failure propagates as the primary error even when the lease-release cleanup that follows it also fails", async () => {
    // The internal catch inside computeVerificationReport must never
    // let a secondary failure cleaning up (releasing the lease, closing
    // runtime) mask the primary error that got it there. Every other
    // fixture in this file has the mocked coordinator's releaseLease
    // resolve cleanly during that catch, which cannot exercise this
    // swallow -- it needs releaseLease to fail too, at exactly this
    // point, to prove window-failure-canary (not release-failure-
    // canary) is what surfaces.
    stubDestinationPrimitives();
    const session = fakeSession();
    session.query = vi.fn(async () => { throw new Error("window-failure-canary"); }) as never;
    const runtime = fakeRuntime({ session });
    vi.spyOn(coordination, "PostgreSqlWorkCoordinator").mockImplementation(function () { return ({
      assertLeaseFence: vi.fn(async () => ({})),
      acquireLease: vi.fn(async () => ({ fencingToken: 1n } as never)),
      releaseLease: vi.fn(async () => { throw new Error("release-failure-canary"); }),
    } as never); });
    const copySource = fakeCopySource();
    const dependencies = dependenciesFor(copySource, runtime);
    await expect(verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-window-and-release-fail" }), dependencies))
      .rejects.toThrow("window-failure-canary");
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("proves a write committed between the source stream and the census window is caught, not absorbed", async () => {
    stubDestinationPrimitives({
      domainCensus: (domain) => (domain === "machines"
        ? { domain, recordCount: 5, prefixSha256: fakeHash("post-injection-prefix"), terminalIdentitySha256: HASH_A }
        : { domain, recordCount: 0, prefixSha256: fakeHash(`prefix-${domain}-0`), terminalIdentitySha256: null }),
    });
    const copySource = fakeCopySource({ recordCounts: { machines: 1 } });
    const runtime = fakeRuntime();
    let injected = false;
    const dependencies = dependenciesFor(copySource, runtime, {
      _afterSourceCheckpointsForTesting: async () => { injected = true; },
    });
    const result = await verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-injection" }), dependencies);
    expect(injected).toBe(true);
    expect(result.outcome).toBe("mismatches");
    expect(result.report.mismatches.some((mismatch) => mismatch.domain === "machines" && mismatch.class === "count")).toBe(true);
  }, 15000);

  describe("in-snapshot transfer-schema admission (B5-1)", () => {
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    it("re-runs the transfer-schema admission on the pinned snapshot session as well as the runtime", async () => {
      stubDestinationPrimitives();
      const session = fakeSession();
      const runtime = fakeRuntime({ session });
      const dependencies = dependenciesFor(fakeCopySource({ recordCounts }), runtime);
      const input = baseInput({ homeDir: "/tmp/lcm-verify-snapshot-admission" });
      const result = await verifyMigrationGeneration(input, dependencies);
      expect(result.outcome).toBe("clean");
      const calls = vi.mocked(dependencies.verifyTransferSchema).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0]![0]).toBe(runtime);
      expect(calls[1]![0]).toBe(session);
      expect(calls[1]![1]).toEqual({
        expectedOwner: input.expectedOwner, signal: input.signal,
      });
    }, 15000);
    it("refuses before any report is persisted when only the in-snapshot admission fails", async () => {
      stubDestinationPrimitives();
      const session = fakeSession();
      const runtime = fakeRuntime({ session });
      const failure = new Error("snapshot-schema-drift-canary");
      const dependencies = dependenciesFor(fakeCopySource({ recordCounts }), runtime, {
        verifyTransferSchema: vi.fn(async (executor: unknown) => {
          if (executor === session) throw failure;
          return {} as never;
        }) as never,
      });
      const persistSpy = vi.spyOn(MigrationVerificationReportStore.prototype, "persist");
      await expect(verifyMigrationGeneration(
        baseInput({ homeDir: "/tmp/lcm-verify-snapshot-admission-fails" }), dependencies,
      )).rejects.toBe(failure);
      expect(persistSpy).not.toHaveBeenCalled();
      expect(runtime.close).toHaveBeenCalledTimes(1);
    }, 15000);
    it("applies the same in-snapshot admission to the read-only inspection", async () => {
      stubDestinationPrimitives();
      const session = fakeSession();
      const runtime = fakeRuntime({ session });
      const failure = new Error("inspect-snapshot-schema-drift-canary");
      const dependencies = dependenciesFor(fakeCopySource({ recordCounts }), runtime, {
        verifyTransferSchema: vi.fn(async (executor: unknown) => {
          if (executor === session) throw failure;
          return {} as never;
        }) as never,
      });
      await expect(inspectMigrationVerification(
        baseInput({ homeDir: "/tmp/lcm-verify-snapshot-admission-inspect" }), dependencies,
      )).rejects.toBe(failure);
    }, 15000);
  });

  it("round-2 P3: releases the lease only after persist has settled, not before it", async () => {
    // Before this fix, the lease was released inside
    // computeVerificationReport before it ever returned to
    // verifyMigrationGeneration, so a second worker could acquire the
    // lease and start a concurrent recomputation while this attempt's
    // persist was still in flight. Recording actual call order --
    // rather than merely asserting release eventually happens, which
    // the existing "still releases the lease" tests already do -- is
    // the only way to prove the ordering rather than just the
    // occurrence.
    stubDestinationPrimitives();
    const order: string[] = [];
    vi.spyOn(coordination, "PostgreSqlWorkCoordinator").mockImplementation(function () { return ({
      assertLeaseFence: vi.fn(async () => ({})),
      acquireLease: vi.fn(async () => ({ fencingToken: 1n } as never)),
      releaseLease: vi.fn(async () => { order.push("release"); return null; }),
    } as never); });
    const originalPersist = MigrationVerificationReportStore.prototype.persist;
    const persistSpy = vi.spyOn(MigrationVerificationReportStore.prototype, "persist").mockImplementation(
      function (this: MigrationVerificationReportStore, ...args: Parameters<typeof originalPersist>) {
        order.push("persist");
        return originalPersist.apply(this, args);
      },
    );
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const copySource = fakeCopySource({ recordCounts });
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(copySource, runtime);
    const result = await verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-lease-release-order" }), dependencies);
    expect(result.outcome).toBe("clean");
    expect(order).toEqual(["persist", "release"]);
    persistSpy.mockRestore();
  }, 15000);
  it("round-4 P1: propagates a lease-release failure rather than masking it, after the report has already reached disk", async () => {
    // Before this fix, releaseLease's own coordinator.releaseLease(...)
    // call was wrapped in .catch(() => undefined), so this exact
    // fixture -- a coordinator whose releaseLease always throws --
    // silently resolved and returned outcome "clean" as though nothing
    // had gone wrong. A release that did not happen must now be
    // distinguishable from one that did: the failure propagates. The
    // report having already reached disk is asserted independently via
    // a persist spy, proving the durable half of this operation is
    // unaffected by the release failure that follows it, rather than
    // merely asserting the promise rejects.
    stubDestinationPrimitives();
    vi.spyOn(coordination, "PostgreSqlWorkCoordinator").mockImplementation(function () { return ({
      assertLeaseFence: vi.fn(async () => ({})),
      acquireLease: vi.fn(async () => ({ fencingToken: 1n } as never)),
      releaseLease: vi.fn(async () => { throw new Error("release-failure-canary"); }),
    } as never); });
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const copySource = fakeCopySource({ recordCounts });
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(copySource, runtime);
    const homeDir = "/tmp/lcm-verify-release-fail";
    let persistedReportSha256: string | undefined;
    const originalPersist = MigrationVerificationReportStore.prototype.persist;
    const persistSpy = vi.spyOn(MigrationVerificationReportStore.prototype, "persist").mockImplementation(
      function (this: MigrationVerificationReportStore, ...args: Parameters<typeof originalPersist>) {
        const outcome = originalPersist.apply(this, args);
        persistedReportSha256 = outcome.report.reportSha256;
        return outcome;
      },
    );
    try {
      await expect(verifyMigrationGeneration(baseInput({ homeDir }), dependencies))
        .rejects.toThrow("release-failure-canary");
    } finally {
      persistSpy.mockRestore();
    }
    expect(persistedReportSha256).toBeDefined();
    const store = new MigrationVerificationReportStore({ homeDir });
    expect(store.has("generation-1", persistedReportSha256!)).toBe(true);
  }, 15000);

  it("round-4 P3: a persist failure propagates over a release failure that follows it, not the reverse", async () => {
    // Before this fix, persist and releaseLease shared a plain
    // try/finally: if persist threw and releaseLease's own finally-
    // block call also threw, ordinary JS try/finally semantics let the
    // finally clause's exception silently replace the try block's --
    // trading a real persist failure for a misattributed release
    // failure. Both are made to throw here, with distinguishable
    // messages, so the assertion can tell which one actually
    // propagated rather than merely that something did.
    stubDestinationPrimitives();
    let releaseLeaseCalled = false;
    vi.spyOn(coordination, "PostgreSqlWorkCoordinator").mockImplementation(function () { return ({
      assertLeaseFence: vi.fn(async () => ({})),
      acquireLease: vi.fn(async () => ({ fencingToken: 1n } as never)),
      releaseLease: vi.fn(async () => { releaseLeaseCalled = true; throw new Error("release-failure-canary"); }),
    } as never); });
    const persistSpy = vi.spyOn(MigrationVerificationReportStore.prototype, "persist").mockImplementation(
      () => { throw new Error("persist-failure-canary"); },
    );
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const copySource = fakeCopySource({ recordCounts });
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(copySource, runtime);
    try {
      await expect(verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-persist-fail-masks-release" }), dependencies))
        .rejects.toThrow("persist-failure-canary");
    } finally {
      persistSpy.mockRestore();
    }
    // releaseLease still ran (and its own failure was swallowed rather
    // than silently skipped), proving the lease is not leaked merely
    // because persist failed first.
    expect(releaseLeaseCalled).toBe(true);
  }, 15000);

  it("round-4 P1 red case: releaseLease's runtime is still open when the release call itself runs, proven against a runtime that rejects work once closed", async () => {
    // The round-2 fix returned releaseLease unreleased so the caller
    // could defer it past persist, but computeVerificationReport's own
    // outer finally closed runtime before that closure was ever handed
    // back -- invisible under the old "wholesale coordinator mock"
    // pattern (a bare vi.fn() releaseLease with no connection to
    // runtime at all cannot see a closed runtime, because it never
    // touches it). This coordinator mock is deliberately not wholesale:
    // its releaseLease genuinely calls runtime.transaction(...), the
    // same primitive the real PostgreSqlWorkCoordinator.releaseLease
    // uses internally, against a runtime that actually tracks closed
    // state and rejects work once closed -- exactly the shape needed to
    // catch "runtime was already closed by the time release ran".
    stubDestinationPrimitives();
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const copySource = fakeCopySource({ recordCounts });
    let closed = false;
    const assertOpen = () => { if (closed) throw new Error("runtime is closed"); };
    const baseRuntime = fakeRuntime();
    const order: string[] = [];
    const runtime = {
      ...baseRuntime,
      query: vi.fn(async (config: never) => { assertOpen(); return baseRuntime.query(config); }),
      transaction: vi.fn(async (callback: never, options: never) => { assertOpen(); return baseRuntime.transaction(callback, options); }),
      openReadOnlySnapshot: vi.fn(async (options: never) => { assertOpen(); return baseRuntime.openReadOnlySnapshot(options); }),
      close: vi.fn(async () => { closed = true; order.push("close"); await baseRuntime.close(); }),
    };
    vi.spyOn(coordination, "PostgreSqlWorkCoordinator").mockImplementation(function () { return ({
      assertLeaseFence: vi.fn(async () => ({})),
      acquireLease: vi.fn(async () => ({ fencingToken: 1n } as never)),
      releaseLease: vi.fn(async () => {
        order.push("release-start");
        await (runtime.transaction as unknown as (callback: () => Promise<null>) => Promise<null>)(async () => null);
        order.push("release-complete");
        return null;
      }),
    } as never); });
    const dependencies = dependenciesFor(copySource, runtime as never);
    const result = await verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-release-runtime-open" }), dependencies);
    expect(result.outcome).toBe("clean");
    // The order, not merely the outcome, is what proves this: under
    // the round-4 defect, coordinator.releaseLease's own
    // .catch(() => undefined) swallowed the "runtime is closed"
    // rejection this fixture would have produced, so result.outcome
    // alone stays "clean" either way and "release-complete" is what
    // never gets pushed -- runtime.transaction was still called (and
    // counted), it just threw internally before reaching that line.
    expect(order).toEqual(["release-start", "release-complete", "close"]);
    expect(runtime.close).toHaveBeenCalledTimes(1);
  }, 15000);

  it("#1415: an immediate second verify of the same generation acquires the lease the first one released", async () => {
    // The release-on-open-runtime test above proves release runs before the
    // runtime closes, but it never models lease state, so it cannot show the
    // consequence that matters to the operator: after a successful verify the
    // lease row is actually free. This coordinator keeps real acquire/release
    // state (a second acquireLease returns null until the first is released),
    // so a release that is skipped or misordered surfaces as
    // lease-unavailable on the second run. The manifest is rewound between
    // runs so the second run is a fresh verification rather than a resume.
    const manifest = stubDestinationPrimitives();
    const initialManifest = manifest.current;
    let held = false;
    const acquireLease = vi.fn(async () => {
      if (held) return null;
      held = true;
      return { fencingToken: 1n } as never;
    });
    const releaseLease = vi.fn(async () => { held = false; return null; });
    vi.spyOn(coordination, "PostgreSqlWorkCoordinator").mockImplementation(function () { return ({
      assertLeaseFence: vi.fn(async () => ({})), acquireLease, releaseLease,
    } as never); });
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const input = baseInput({ homeDir: "/tmp/lcm-verify-second-acquire" });
    const first = await verifyMigrationGeneration(
      input, dependenciesFor(fakeCopySource({ recordCounts }), fakeRuntime()),
    );
    expect(first.outcome).toBe("clean");
    expect(held).toBe(false);
    manifest.current = initialManifest;
    const second = await verifyMigrationGeneration(
      input, dependenciesFor(fakeCopySource({ recordCounts }), fakeRuntime()),
    );
    expect(second.outcome).toBe("clean");
    expect(acquireLease).toHaveBeenCalledTimes(2);
    expect(releaseLease).toHaveBeenCalledTimes(2);
    expect(held).toBe(false);
  }, 15000);

  it("uses the production default dependencies when none are injected", async () => {
    stubDestinationPrimitives();
    const copySource = fakeCopySource();
    vi.spyOn(copySourceModule, "openMigrationCopySource").mockResolvedValue(copySource as never);
    vi.spyOn(runtimeReadiness, "verifyPostgreSqlTransferSchema").mockResolvedValue({} as never);
    // No fake createRuntime is supplied: the module's default dependency
    // constructs a real PostgreSqlRuntime, whose Pool never connects until
    // a query runs. The very next real query (an unreachable localhost) is
    // expected to fail fast; this exercises the default factory itself
    // rather than asserting anything about a live PostgreSQL server.
    await expect(verifyMigrationGeneration(baseInput({
      homeDir: "/tmp/lcm-verify-default-deps",
      destinationSettings: {
        url: "postgresql://runtime:secret@127.0.0.1:1/dest", caFile: fileURLToPath(new URL("../../package.json", import.meta.url)),
        poolMax: 1, connectionTimeoutMs: 200, idleTimeoutMs: 200, statementTimeoutMs: 200,
      },
    }))).rejects.toThrow();
  }, 15000);

  it("steps 10-11: begins and completes the manifest effect for a genuinely eligible report", async () => {
    const manifest = stubDestinationPrimitives();
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const copySource = fakeCopySource({ recordCounts });
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(copySource, runtime);
    const result = await verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-begin-complete" }), dependencies);
    expect(result.outcome).toBe("clean");
    expect(result.report.activationEligible).toBe(true);
    // The manifest actually advanced through the real protocol state
    // machine: phase "copied" -> "verified", the pending effect closed,
    // and the verification report reference appended -- not merely a
    // driver-local flag.
    expect(manifest.current.phase).toBe("verified");
    expect(manifest.current.activationEligible).toBe(true);
    expect(manifest.current.pendingEffect).toBe(null);
    // The fixture manifest already carries one "dry-run" report from
    // buildCopiedManifestFixture's own setup; this asserts the new
    // verification report reference was appended alongside it, not that
    // it replaced it.
    expect(manifest.current.reports).toHaveLength(2);
    expect(manifest.current.reports).toContainEqual(
      { kind: "verification", reportId: result.report.reportId, reportSha256: result.report.reportSha256, createdAt: expect.any(String) },
    );
  }, 15000);

  it("round-1 P2: a resumed completion binds the report's createdAt to the effect's startedAt, not to the resume attempt's own wall clock", async () => {
    // The effect began at a fixed, known-past instant (MANIFEST_FIXTURE_AT,
    // 2026-01-01), well before "now" at test-run time. If createdAt were
    // still bound to a fresh completedAt wall clock (the round-1 defect),
    // this assertion would see today's date instead and fail outright --
    // no timer or Date mocking needed, since the two values are already
    // naturally far apart.
    const homeDir = "/tmp/lcm-verify-created-at-binds-to-started-at";
    stubDestinationPrimitives();
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const firstResult = await verifyMigrationGeneration(
      baseInput({ homeDir }), dependenciesFor(fakeCopySource({ recordCounts }), fakeRuntime()),
    );
    expect(firstResult.outcome).toBe("clean");

    // Simulate a crash between begin and complete, exactly like the
    // no-recompute resume test above, but starting the effect at the
    // fixed MANIFEST_FIXTURE_AT instant rather than "now".
    const resumeManifestStore = fakeManifestStore();
    resumeManifestStore.current = beginMigrationEffect(resumeManifestStore.current, {
      kind: "verify-generation", effectId: firstResult.effectId, inputSha256: firstResult.inputSha256,
      startedAt: MANIFEST_FIXTURE_AT,
    });
    const resumedResult = await verifyMigrationGeneration(baseInput({ homeDir }), {
      openSource: vi.fn(async () => { throw new Error("resume must not reopen the source"); }) as never,
      createRuntime: vi.fn(() => { throw new Error("resume must not open a fresh runtime"); }) as never,
      verifyTransferSchema: vi.fn(async () => { throw new Error("resume must not re-verify the transfer schema"); }) as never,
    });
    expect(resumedResult.outcome).toBe("clean");
    // The wall clock at resume time is today's date, not
    // MANIFEST_FIXTURE_AT -- so this only passes if createdAt was bound
    // to the effect's own startedAt rather than to this resume attempt's
    // completedAt.
    expect(resumeManifestStore.current.reports).toContainEqual(
      { kind: "verification", reportId: resumedResult.report.reportId, reportSha256: resumedResult.report.reportSha256, createdAt: MANIFEST_FIXTURE_AT },
    );
  }, 15000);

  it("does not begin an effect for an ineligible report: persisted evidence only, no pending effect", async () => {
    // The "operator evidence" path: a badly diverged destination still
    // gets a persisted report, but plan-v4's steps 10-11 never run for
    // it, so the manifest is untouched and a resumed call cannot wedge
    // on an effect that was never begun.
    const manifest = stubDestinationPrimitives({
      domainCensus: (domain) => ({ domain, recordCount: 99, prefixSha256: fakeHash(`wrong-${domain}`), terminalIdentitySha256: HASH_A }),
    });
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => [domain, 1])) as Partial<Record<PortableDomain, number>>;
    const copySource = fakeCopySource({ recordCounts });
    const runtime = fakeRuntime({ session: fakeSession({ ledgerIdentityTotal: 99 * PORTABLE_RECORD_DOMAIN_ORDER.length }) });
    const dependencies = dependenciesFor(copySource, runtime);
    const result = await verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-ineligible-no-begin" }), dependencies);
    expect(result.outcome).toBe("mismatches");
    expect(result.report.activationEligible).toBe(false);
    expect(manifest.current.phase).toBe("copied");
    expect(manifest.current.pendingEffect).toBe(null);
    // Only the fixture's own pre-existing dry-run report: no verification
    // report reference was ever appended for this ineligible attempt.
    expect(manifest.current.reports).toHaveLength(1);
    expect(manifest.current.reports.every((report) => report.kind !== "verification")).toBe(true);
  }, 15000);

  it("a pending verify-generation effect resumes by completing the persisted report, without ever reopening the source -- proving both no recomputation and no wedge under destination drift", async () => {
    const homeDir = "/tmp/lcm-verify-resume-no-recompute";
    const manifest = stubDestinationPrimitives();
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const firstResult = await verifyMigrationGeneration(
      baseInput({ homeDir }), dependenciesFor(fakeCopySource({ recordCounts }), fakeRuntime()),
    );
    expect(firstResult.outcome).toBe("clean");
    expect(manifest.current.phase).toBe("verified");

    // Simulate a crash that landed exactly between begin and complete: a
    // fresh manifest, still at "copied", with the same effect begun but
    // never completed. This attempt's own evidence -- the persisted
    // report bytes -- is already on disk from the run above, under the
    // same reportSha256, since persist always precedes begin.
    const resumeManifestStore = fakeManifestStore();
    resumeManifestStore.current = beginMigrationEffect(resumeManifestStore.current, {
      kind: "verify-generation", effectId: firstResult.effectId, inputSha256: firstResult.inputSha256,
      startedAt: MANIFEST_FIXTURE_AT,
    });
    // Also simulate the destination having drifted since begin: if the
    // resumed attempt recomputed the census at all, this would produce a
    // different, non-eligible report. The openSource spy below proves it
    // is never even called, so the drift below is never actually read --
    // that is the point.
    const driftedCensus = (domain: PortableDomain) => ({
      domain, recordCount: 999, prefixSha256: fakeHash(`drifted-${domain}`), terminalIdentitySha256: HASH_A,
    });
    vi.spyOn(portableSource, "readPostgreSqlPortableSourceDomainCensus").mockImplementation(((_source: unknown, domain: PortableDomain) => driftedCensus(domain)) as never);
    const openSourceSpy = vi.fn(async () => { throw new Error("resume must not reopen the source"); });
    const createRuntimeSpy = vi.fn(() => { throw new Error("resume must not open a fresh runtime"); });
    const resumedResult = await verifyMigrationGeneration(baseInput({ homeDir }), {
      openSource: openSourceSpy as never, createRuntime: createRuntimeSpy as never,
      verifyTransferSchema: vi.fn(async () => { throw new Error("resume must not re-verify the transfer schema"); }) as never,
    });
    expect(openSourceSpy).not.toHaveBeenCalled();
    expect(createRuntimeSpy).not.toHaveBeenCalled();
    expect(resumedResult.report).toEqual(firstResult.report);
    expect(resumedResult.effectId).toBe(firstResult.effectId);
    expect(resumedResult.inputSha256).toBe(firstResult.inputSha256);
    // Terminal state reached despite the drift: no wedge.
    expect(resumeManifestStore.current.phase).toBe("verified");
    expect(resumeManifestStore.current.pendingEffect).toBe(null);
  }, 15000);

  it("kBcQG: refuses to resume when the pending effect does not name the persisted report, leaving the manifest untouched", async () => {
    const homeDir = "/tmp/lcm-verify-resume-effect-mismatch";
    rmSync(homeDir, { recursive: true, force: true });
    stubDestinationPrimitives();
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const firstResult = await verifyMigrationGeneration(
      baseInput({ homeDir }), dependenciesFor(fakeCopySource({ recordCounts }), fakeRuntime()),
    );
    expect(firstResult.report.activationEligible).toBe(true);
    const resumeManifestStore = fakeManifestStore();
    resumeManifestStore.current = beginMigrationEffect(resumeManifestStore.current, {
      kind: "verify-generation", effectId: "verify-generation-" + fakeHash("some-other-report"),
      inputSha256: firstResult.inputSha256, startedAt: MANIFEST_FIXTURE_AT,
    });
    const beforeManifest = resumeManifestStore.current;
    const error = await verifyMigrationGeneration(baseInput({ homeDir }), dependenciesFor(fakeCopySource(), fakeRuntime()))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationVerificationDriverError);
    expect((error as MigrationVerificationDriverError).reason).toBe("report-identity-conflict");
    expect(resumeManifestStore.current).toBe(beforeManifest);
    expect(resumeManifestStore.current.phase).toBe("copied");
  }, 15000);

  it("kBcQG: refuses to resume a pending effect whose persisted report is not activation-eligible, leaving the manifest untouched", async () => {
    const homeDir = "/tmp/lcm-verify-resume-ineligible-report";
    rmSync(homeDir, { recursive: true, force: true });
    stubDestinationPrimitives({
      domainCensus: (domain) => ({ domain, recordCount: 99, prefixSha256: fakeHash(`wrong-${domain}`), terminalIdentitySha256: HASH_A }),
    });
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => [domain, 1])) as Partial<Record<PortableDomain, number>>;
    const runtime = fakeRuntime({ session: fakeSession({ ledgerIdentityTotal: 99 * PORTABLE_RECORD_DOMAIN_ORDER.length }) });
    const firstResult = await verifyMigrationGeneration(
      baseInput({ homeDir }), dependenciesFor(fakeCopySource({ recordCounts }), runtime),
    );
    expect(firstResult.report.activationEligible).toBe(false);
    // An ineligible report is persisted as evidence but never begun. A
    // pending effect that nonetheless names it must not be completed as
    // eligible, even though its effect id is exactly the report's own.
    const resumeManifestStore = fakeManifestStore();
    resumeManifestStore.current = beginMigrationEffect(resumeManifestStore.current, {
      kind: "verify-generation", effectId: firstResult.effectId, inputSha256: firstResult.inputSha256,
      startedAt: MANIFEST_FIXTURE_AT,
    });
    const beforeManifest = resumeManifestStore.current;
    const error = await verifyMigrationGeneration(baseInput({ homeDir }), dependenciesFor(fakeCopySource(), fakeRuntime()))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationVerificationDriverError);
    expect((error as MigrationVerificationDriverError).reason).toBe("report-identity-conflict");
    expect(resumeManifestStore.current).toBe(beforeManifest);
    expect(resumeManifestStore.current.reports.every((report) => report.kind !== "verification")).toBe(true);
  }, 15000);

  it("refuses to resume a pending effect whose persisted report destination differs from the sealed manifest, leaving the manifest pending", async () => {
    const homeDir = "/tmp/lcm-verify-resume-destination-drift";
    rmSync(homeDir, { recursive: true, force: true });
    stubDestinationPrimitives();
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const firstResult = await verifyMigrationGeneration(
      baseInput({ homeDir }), dependenciesFor(fakeCopySource({ recordCounts }), fakeRuntime()),
    );
    expect(firstResult.report.activationEligible).toBe(true);
    // The persisted eligible report froze HASH_A as its sealed witness. The
    // pending effect names it correctly, but the sealed manifest now carries
    // a different destination identity, so completion must refuse.
    const resumeManifestStore = fakeManifestStore();
    const begun = beginMigrationEffect(resumeManifestStore.current, {
      kind: "verify-generation", effectId: firstResult.effectId, inputSha256: firstResult.inputSha256,
      startedAt: MANIFEST_FIXTURE_AT,
    });
    resumeManifestStore.current = {
      ...begun, destination: { ...begun.destination, identitySha256: fakeHash("drifted-destination") },
    };
    const beforeManifest = resumeManifestStore.current;
    const error = await verifyMigrationGeneration(baseInput({ homeDir }), dependenciesFor(fakeCopySource(), fakeRuntime()))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationVerificationDriverError);
    expect((error as MigrationVerificationDriverError).reason).toBe("destination-drift");
    expect(resumeManifestStore.current).toBe(beforeManifest);
    expect(resumeManifestStore.current.phase).toBe("copied");
    expect(resumeManifestStore.current.pendingEffect).not.toBe(null);
  }, 15000);

  it.each([
    ["a legacy manifest that never recorded a system identifier", undefined],
    ["a manifest that recorded a different cluster's system identifier", "7000000001"],
  ] as const)("refuses to resume a pending effect for %s, leaving the manifest pending", async (_label, recordedIdentifier) => {
    const homeDir = "/tmp/lcm-verify-resume-system-identifier-" + String(recordedIdentifier);
    rmSync(homeDir, { recursive: true, force: true });
    stubDestinationPrimitives();
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const firstResult = await verifyMigrationGeneration(
      baseInput({ homeDir }), dependenciesFor(fakeCopySource({ recordCounts }), fakeRuntime()),
    );
    expect(firstResult.report.activationEligible).toBe(true);
    // The persisted eligible report froze the live cluster identifier
    // "7123456789" and the sealed witness matches the manifest, so only the
    // manifest's recorded system identifier can refuse this resume.
    const resumeManifestStore = fakeManifestStore();
    const begun = beginMigrationEffect(resumeManifestStore.current, {
      kind: "verify-generation", effectId: firstResult.effectId, inputSha256: firstResult.inputSha256,
      startedAt: MANIFEST_FIXTURE_AT,
    });
    const { systemIdentifier: _recorded, ...withoutIdentifier } = begun.destination;
    resumeManifestStore.current = {
      ...begun,
      destination: recordedIdentifier === undefined ? withoutIdentifier : { ...withoutIdentifier, systemIdentifier: recordedIdentifier },
    };
    const beforeManifest = resumeManifestStore.current;
    const error = await verifyMigrationGeneration(baseInput({ homeDir }), dependenciesFor(fakeCopySource(), fakeRuntime()))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationVerificationDriverError);
    expect((error as MigrationVerificationDriverError).reason).toBe("destination-drift");
    expect((error as MigrationVerificationDriverError).message).toContain("system identifier");
    expect(resumeManifestStore.current).toBe(beforeManifest);
    expect(resumeManifestStore.current.phase).toBe("copied");
    expect(resumeManifestStore.current.pendingEffect).not.toBe(null);
  }, 15000);

  it("refuses when a different effect is already pending for the generation, rather than silently adopting it", async () => {
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const manifest = stubDestinationPrimitives();
    // "abort" is the only other effect legal from phase "copied" besides
    // "verify-generation" -- begin it without completing, simulating a
    // concurrent operator-initiated abort racing this verification pass.
    // This attempt's own report computation still runs to completion
    // (the destination fixture is sound), but begin() must see the
    // mismatched pending effect and refuse rather than adopt it.
    manifest.current = beginMigrationEffect(manifest.current, {
      kind: "abort", effectId: "concurrent-abort", inputSha256: HASH_A, startedAt: MANIFEST_FIXTURE_AT,
    });
    const copySource = fakeCopySource({ recordCounts });
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(copySource, runtime);
    await expect(verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-conflicting-pending-effect" }), dependencies))
      .rejects.toMatchObject({ reason: "report-identity-conflict" });
  }, 15000);
});

describe("inspectMigrationVerification", () => {
  it("produces a report identical to what verifyMigrationGeneration would produce, and never touches the manifest or persists anything", async () => {
    const manifest = stubDestinationPrimitives();
    const beforeManifest = manifest.current;
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const homeDir = "/tmp/lcm-verify-inspect-parity";
    // Self-contained regardless of any earlier run's leftover state: the
    // "not yet persisted" assertion below is only meaningful against a
    // clean store.
    rmSync(homeDir, { recursive: true, force: true });
    const inspected = await inspectMigrationVerification(
      baseInput({ homeDir }), dependenciesFor(fakeCopySource({ recordCounts }), fakeRuntime()),
    );
    // Reference equality, not just deep equality: nothing in
    // inspectMigrationVerification's call graph can reach
    // MigrationManifestStore.update at all, so the fake's closure-held
    // manifest object is never even reassigned, let alone changed.
    expect(manifest.current).toBe(beforeManifest);
    // No report artifact exists on disk under this report's identity.
    const store = new MigrationVerificationReportStore({ homeDir });
    expect(store.has("generation-1", inspected.reportSha256)).toBe(false);

    // A publishing run against the identical, still-unpersisted fixture
    // produces a byte-identical report: the report body carries no live
    // timestamp of its own, so recomputation is deterministic.
    const published = await verifyMigrationGeneration(
      baseInput({ homeDir }), dependenciesFor(fakeCopySource({ recordCounts }), fakeRuntime()),
    );
    expect(published.report).toEqual(inspected);
    expect(store.has("generation-1", inspected.reportSha256)).toBe(true);
    expect(manifest.current.phase).toBe("verified");
  }, 15000);

  it("also returns the same report shape for an ineligible destination, without ever persisting it", async () => {
    stubDestinationPrimitives({
      domainCensus: (domain) => ({ domain, recordCount: 99, prefixSha256: fakeHash(`inspect-mismatch-${domain}`), terminalIdentitySha256: HASH_A }),
    });
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => [domain, 1])) as Partial<Record<PortableDomain, number>>;
    const homeDir = "/tmp/lcm-verify-inspect-ineligible";
    rmSync(homeDir, { recursive: true, force: true });
    const runtime = fakeRuntime({ session: fakeSession({ ledgerIdentityTotal: 99 * PORTABLE_RECORD_DOMAIN_ORDER.length }) });
    const inspected = await inspectMigrationVerification(
      baseInput({ homeDir }), dependenciesFor(fakeCopySource({ recordCounts }), runtime),
    );
    expect(inspected.activationEligible).toBe(false);
    expect(inspected.mismatches.length).toBeGreaterThan(0);
    const store = new MigrationVerificationReportStore({ homeDir });
    expect(store.has("generation-1", inspected.reportSha256)).toBe(false);
  }, 15000);
});

describe("verification lease fence (#1428)", () => {
  const FENCE_TOKEN = 7n;
  const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
  const leaseLost = () => new coordination.PostgreSqlLeaseFenceError(projectId, machineId, FENCE_TOKEN, "assertLeaseFence");

  /** Records one ordered event log across the snapshot close, each fence
   * check, persist and release, so a test can assert where the fences sit. */
  function arrange(options: {
    failFence?: { call: number; error: () => Error };
    releaseFails?: boolean;
  } = {}) {
    stubDestinationPrimitives();
    const order: string[] = [];
    const session = fakeSession();
    session.close = vi.fn(async () => { order.push("snapshot-close"); });
    const runtime = fakeRuntime({ session });
    const assertLeaseFence = vi.fn(async () => {
      order.push("fence");
      const failure = options.failFence;
      if (failure !== undefined && assertLeaseFence.mock.calls.length === failure.call) throw failure.error();
      return {};
    });
    const releaseLease = vi.fn(async () => {
      order.push("release");
      if (options.releaseFails === true) throw new Error("release-failure-canary");
      return null;
    });
    vi.spyOn(coordination, "PostgreSqlWorkCoordinator").mockImplementation(function () { return ({
      assertLeaseFence, releaseLease,
      acquireLease: vi.fn(async () => ({ fencingToken: FENCE_TOKEN } as never)),
    } as never); });
    const originalPersist = MigrationVerificationReportStore.prototype.persist;
    const persist = vi.spyOn(MigrationVerificationReportStore.prototype, "persist").mockImplementation(function (this: MigrationVerificationReportStore, ...args) {
      order.push("persist");
      return originalPersist.apply(this, args);
    });
    return { order, runtime, assertLeaseFence, releaseLease, persist };
  }

  function homeDirFor(label: string): string {
    const homeDir = "/tmp/lcm-verify-fence-" + label;
    rmSync(homeDir, { recursive: true, force: true });
    return homeDir;
  }

  it("fences the lease on a fresh read-committed transaction after the census snapshot closes and again right before persist", async () => {
    const { order, runtime, assertLeaseFence, releaseLease } = arrange();
    const result = await verifyMigrationGeneration(
      baseInput({ homeDir: homeDirFor("ok") }), dependenciesFor(fakeCopySource({ recordCounts }), runtime),
    );
    expect(result.outcome).toBe("clean");
    expect(order).toEqual(["snapshot-close", "fence", "fence", "persist", "release"]);
    expect(assertLeaseFence).toHaveBeenCalledTimes(2);
    for (const call of assertLeaseFence.mock.calls as unknown as Array<[Record<string, unknown>]>) {
      expect(call[0]).toMatchObject({
        resourceType: "migration-verification", resourceKey: "generation-1", processId: "worker-1",
        operation: "verify-generation", fencingToken: FENCE_TOKEN,
      });
    }
    expect(runtime.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      operation: "verifyGenerationLeaseFence", projectId, machineId, transactionMode: "read-committed-read-write",
    }));
    expect(releaseLease).toHaveBeenCalledTimes(1);
  }, 15000);

  it("inspect fences once after the window, then releases, and never persists", async () => {
    const { order, runtime, assertLeaseFence, persist } = arrange();
    await inspectMigrationVerification(
      baseInput({ homeDir: homeDirFor("inspect-ok") }), dependenciesFor(fakeCopySource({ recordCounts }), runtime),
    );
    expect(order).toEqual(["snapshot-close", "fence", "release"]);
    expect(assertLeaseFence).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
  }, 15000);

  const sites = [
    { site: "after the census window", call: 1, events: ["snapshot-close", "fence", "release"] },
    { site: "immediately before persist", call: 2, events: ["snapshot-close", "fence", "fence", "release"] },
  ];
  describe.each(sites)("fence $site", ({ site, call, events }) => {
    const label = site.replaceAll(" ", "-");

    it("maps a lost lease to lease-lost, publishes nothing, and still releases and closes", async () => {
      const { order, runtime, assertLeaseFence, releaseLease, persist } = arrange({ failFence: { call, error: leaseLost } });
      const error = await verifyMigrationGeneration(
        baseInput({ homeDir: homeDirFor("lost-" + label) }), dependenciesFor(fakeCopySource({ recordCounts }), runtime),
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MigrationVerificationDriverError);
      expect((error as MigrationVerificationDriverError).reason).toBe("lease-lost");
      expect((error as MigrationVerificationDriverError).cause).toBeInstanceOf(coordination.PostgreSqlLeaseFenceError);
      expect(persist).not.toHaveBeenCalled();
      expect(order).toEqual(events);
      expect(assertLeaseFence).toHaveBeenCalledTimes(call);
      expect(releaseLease).toHaveBeenCalledTimes(1);
      expect(runtime.close).toHaveBeenCalledTimes(1);
    }, 15000);

    it("lets a non-fence error propagate unchanged and still releases and closes", async () => {
      const failure = new Error("fence-transport-canary");
      const { order, runtime, releaseLease, persist } = arrange({ failFence: { call, error: () => failure } });
      const error = await verifyMigrationGeneration(
        baseInput({ homeDir: homeDirFor("other-" + label) }), dependenciesFor(fakeCopySource({ recordCounts }), runtime),
      ).catch((caught: unknown) => caught);
      expect(error).toBe(failure);
      expect(persist).not.toHaveBeenCalled();
      expect(order).toEqual(events);
      expect(releaseLease).toHaveBeenCalledTimes(1);
      expect(runtime.close).toHaveBeenCalledTimes(1);
    }, 15000);

    it("reports the lost lease, not a release failure that follows it", async () => {
      const { runtime, releaseLease, persist } = arrange({ failFence: { call, error: leaseLost }, releaseFails: true });
      const error = await verifyMigrationGeneration(
        baseInput({ homeDir: homeDirFor("release-fails-" + label) }), dependenciesFor(fakeCopySource({ recordCounts }), runtime),
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MigrationVerificationDriverError);
      expect((error as MigrationVerificationDriverError).reason).toBe("lease-lost");
      expect(persist).not.toHaveBeenCalled();
      expect(releaseLease).toHaveBeenCalledTimes(1);
      expect(runtime.close).toHaveBeenCalledTimes(1);
    }, 15000);
  });

  describe("inspect, after-window fence", () => {
    it("maps a lost lease to lease-lost and still releases and closes", async () => {
      const { order, runtime, releaseLease } = arrange({ failFence: { call: 1, error: leaseLost } });
      const error = await inspectMigrationVerification(
        baseInput({ homeDir: homeDirFor("inspect-lost") }), dependenciesFor(fakeCopySource({ recordCounts }), runtime),
      ).catch((caught: unknown) => caught);
      expect((error as MigrationVerificationDriverError).reason).toBe("lease-lost");
      expect(order).toEqual(["snapshot-close", "fence", "release"]);
      expect(releaseLease).toHaveBeenCalledTimes(1);
      expect(runtime.close).toHaveBeenCalledTimes(1);
    }, 15000);

    it("lets a non-fence error propagate unchanged", async () => {
      const failure = new Error("fence-transport-canary");
      const { runtime } = arrange({ failFence: { call: 1, error: () => failure } });
      await expect(inspectMigrationVerification(
        baseInput({ homeDir: homeDirFor("inspect-other") }), dependenciesFor(fakeCopySource({ recordCounts }), runtime),
      )).rejects.toBe(failure);
    }, 15000);

    it("reports the lost lease, not a release failure that follows it", async () => {
      const { runtime } = arrange({ failFence: { call: 1, error: leaseLost }, releaseFails: true });
      const error = await inspectMigrationVerification(
        baseInput({ homeDir: homeDirFor("inspect-release-fails") }), dependenciesFor(fakeCopySource({ recordCounts }), runtime),
      ).catch((caught: unknown) => caught);
      expect((error as MigrationVerificationDriverError).reason).toBe("lease-lost");
    }, 15000);
  });
});

describe("readSequenceSelfConsistencyMismatches", () => {
  it("round-1 P2 red case: refuses when the live schema's identity columns disagree with SEQUENCE_BACKED_IDENTITY_COLUMN", async () => {
    // A stale map -- one that no longer matches what pg_catalog actually
    // reports as identity-backed under schema lcm -- must refuse rather
    // than silently let the self-consistency bound run against an
    // incomplete or wrong set of columns while sequence classCoverage
    // still claims ran: true.
    const session = fakeSession({
      identityColumns: [{ tableName: "conversations", columnName: "conversation_id" }],
    });
    await expect(readSequenceSelfConsistencyMismatches(session as never, projectId))
      .rejects.toMatchObject({ reason: "invalid-input" });
  });
  it("skips a domain whose sequence has never been called and the max identity is null (empty domain)", async () => {
    const session = fakeSession();
    const mismatches = await readSequenceSelfConsistencyMismatches(session as never, projectId);
    expect(mismatches).toEqual([]);
  });
  it("flags a domain whose sequence last_value is null even though rows exist (never called despite copied data)", async () => {
    const session = fakeSession({ sequenceState: { conversations: { maxValue: "500", lastValue: null } } });
    // sequenceState omits the sequence entirely (no seq_name resolvable),
    // so readSequenceStoredState returns null: a sequence that cannot be
    // read at all must fail closed, exactly like one that is genuinely
    // never-called with a colliding start value.
    const mismatches = await readSequenceSelfConsistencyMismatches(session as never, projectId);
    expect(mismatches).toEqual([{ domain: "conversations", class: "sequence", identitySha256: expect.any(String) }]);
  });
  it("flags a never-called sequence (is_called=false) whose start value collides with the copied maximum", async () => {
    const session = fakeSession({ sequenceState: {
      conversations: { maxValue: "1", lastValue: "1", isCalled: false, incrementBy: "1" },
    } });
    const mismatches = await readSequenceSelfConsistencyMismatches(session as never, projectId);
    expect(mismatches).toEqual([{ domain: "conversations", class: "sequence", identitySha256: expect.any(String) }]);
  });
  it("flags a domain whose sequence last_value is strictly below the copied maximum identity", async () => {
    const session = fakeSession({ sequenceState: { messages: { maxValue: "1000", lastValue: "999", isCalled: true, incrementBy: "1" } } });
    const mismatches = await readSequenceSelfConsistencyMismatches(session as never, projectId);
    expect(mismatches).toEqual([{ domain: "messages", class: "sequence", identitySha256: expect.any(String) }]);
  });
  it("passes a never-called sequence whose start value is strictly ahead of the copied maximum", async () => {
    const session = fakeSession({ sequenceState: {
      conversations: { maxValue: "1", lastValue: "2", isCalled: false, incrementBy: "1" },
    } });
    const mismatches = await readSequenceSelfConsistencyMismatches(session as never, projectId);
    expect(mismatches).toEqual([]);
  });
  it("passes when the sequence last_value is at or above the copied maximum identity", async () => {
    const session = fakeSession({ sequenceState: {
      conversations: { maxValue: "500", lastValue: "500", isCalled: true, incrementBy: "1" },
      "recall-surfacings": { maxValue: "10", lastValue: "11", isCalled: true, incrementBy: "1" },
    } });
    const mismatches = await readSequenceSelfConsistencyMismatches(session as never, projectId);
    expect(mismatches).toEqual([]);
  });
  it("fails closed when the sequence backing an identity column cannot be resolved at all", async () => {
    // pg_get_serial_sequence returning NULL for a table/column this map
    // claims is identity-backed would mean the map itself has drifted from
    // the schema; that must fail closed rather than silently pass.
    const session = {
      query: vi.fn(async (config: { text: string }) => {
        if (config.text.includes("attidentity")) {
          return { rows: Object.values(SEQUENCE_BACKED_IDENTITY_COLUMN).map((target) => ({ table_name: target!.table.replace("lcm.", ""), column_name: target!.column })) };
        }
        if (config.text.includes("MAX(")) return { rows: [{ max_value: "500" }] };
        if (config.text.includes("pg_get_serial_sequence")) return { rows: [{ seq_name: null }] };
        return { rows: [{ admitted: true }] };
      }),
      close: vi.fn(async () => { /* fake */ }),
    };
    const mismatches = await readSequenceSelfConsistencyMismatches(session as never, projectId);
    expect(mismatches.length).toBeGreaterThan(0);
    expect(mismatches.every((mismatch) => mismatch.class === "sequence")).toBe(true);
  });
  it("refuses with a privilege-denied marker, never the generic violation marker, when the querying role lacks USAGE/SELECT on a non-empty domain's sequence", async () => {
    // A privilege gap and a genuinely never-called sequence both surface
    // as NULL from pg_sequences.last_value, and collapsing them would let
    // a misconfigured role read as a healthy "never called, start value
    // ahead" sequence. has_sequence_privilege must be consulted first so
    // this refuses for its own distinct, attributable reason.
    const session = fakeSession({ sequenceState: {
      conversations: { maxValue: "5", lastValue: "5", privilegeDenied: true },
    } });
    const mismatches = await readSequenceSelfConsistencyMismatches(session as never, projectId);
    expect(mismatches).toEqual([{
      domain: "conversations", class: "sequence",
      identitySha256: expect.any(String),
    }]);
    expect(mismatches[0]?.identitySha256).not.toBe(
      // The generic violation marker this must not be confused with.
      await import("../../src/migration/activation-witness.js")
        .then((module) => module.migrationWitnessSha256(["sequence-self-consistency-violation-v1", "conversations"])),
    );
    expect(mismatches[0]?.identitySha256).toBe(
      await import("../../src/migration/activation-witness.js")
        .then((module) => module.migrationWitnessSha256(["sequence-self-consistency-privilege-denied-v1", "conversations"])),
    );
  });
});

describe("truncateMismatchesPerClass", () => {
  it("retains only the frozen per-class limit while leaving other classes untouched", () => {
    const overLimit = Array.from({ length: 150 }, (_, index) => ({
      domain: "machines" as const, class: "count" as const,
      identitySha256: fakeHash(`bound-${String(index).padStart(4, "0")}`),
    })).sort((left, right) => (left.identitySha256 < right.identitySha256 ? -1 : 1));
    const untouchedClass = [{ domain: "project" as const, class: "digest" as const, identitySha256: fakeHash("untouched") }];
    const totals = totalsFor([...overLimit, ...untouchedClass]);
    expect(totals).toEqual(expect.arrayContaining([
      { domain: "machines", class: "count", count: 150 },
      { domain: "project", class: "digest", count: 1 },
    ]));
    const truncated = truncateMismatchesPerClass([...overLimit, ...untouchedClass]);
    const retainedCount = truncated.filter((mismatch) => mismatch.class === "count").length;
    expect(retainedCount).toBe(100);
    expect(truncated.filter((mismatch) => mismatch.class === "digest")).toEqual(untouchedClass);
    // The retained subset preserves the original relative order: filtering
    // a sorted sequence can never reorder it.
    expect(truncated.filter((mismatch) => mismatch.class === "count")).toEqual(overLimit.slice(0, 100));
  });

  it("round-2 P1 red case: truncating per class alone orphans a second domain's total, through the real report constructor", () => {
    // The defect: 150 relation mismatches on "machines" plus 1 on
    // "project" retained the frozen limit's worth of entries entirely
    // from "machines" (the earlier domain in frozen order) and dropped
    // every "project" entry in the same class -- but totalsFor still
    // recorded (project, relation, 1) from the untruncated list, and
    // createMigrationVerificationReportBody's own consistency check
    // refuses any total with zero retained entries. A wrong-parent
    // failure spanning two domains therefore threw before persist
    // instead of producing a refused report or operator evidence, for
    // exactly the badly diverged destination this path exists to serve.
    const machinesMismatches = Array.from({ length: 150 }, (_, index) => ({
      domain: "machines" as const, class: "relation" as const,
      identitySha256: fakeHash(`relation-machines-${String(index).padStart(4, "0")}`),
    }));
    const projectMismatches = [{ domain: "project" as const, class: "relation" as const, identitySha256: fakeHash("relation-project-0") }];
    const order = [...PORTABLE_RECORD_DOMAIN_ORDER, "schema", "ledger", "public-listing"] as const;
    const fullMismatches = sortMismatches([...machinesMismatches, ...projectMismatches], order);
    const mismatchTotals = sortMismatches(
      totalsFor(fullMismatches) as unknown as typeof fullMismatches, order,
    ).map((total) => ({ domain: total.domain, class: total.class, count: (total as unknown as { count: number }).count }));
    expect(mismatchTotals).toEqual(expect.arrayContaining([
      { domain: "machines", class: "relation", count: 150 },
      { domain: "project", class: "relation", count: 1 },
    ]));
    const truncated = truncateMismatchesPerClass(fullMismatches);
    // Every domain that had a mismatch in this class keeps at least one
    // retained entry: the orphan this test exists to catch would show up
    // here as an empty array for "project".
    expect(truncated.filter((mismatch) => mismatch.domain === "project" && mismatch.class === "relation")).toHaveLength(1);
    expect(truncated.filter((mismatch) => mismatch.class === "relation")).toHaveLength(100);
    const domainVector = <T>(build: (domain: PortableDomain, index: number) => T): T[] => PORTABLE_RECORD_DOMAIN_ORDER.map(build);
    expect(() => createMigrationVerificationReportBody({
      generationId: "generation-1", targetGenerationId: "generation-1-postgresql",
      bindingSha256: HASH_A, manifestRevision: 1, manifestChecksumSha256: HASH_A,
      sourceWitness: { version: 1, identitySha256: HASH_A, schemaSha256: HASH_A, contentSha256: HASH_A },
      destinationIdentity: { version: 1, sealedWitnessSha256: HASH_A, systemIdentifier: "712345" },
      destinationSchemaWitness: {
        version: 1, migrationsSha256: HASH_A, searchConfigurationSha256: HASH_A,
        collationSha256: HASH_A, sequenceStateSha256: HASH_A,
      },
      projectMapWitnessSha256: HASH_A,
      queueClassificationWitness: {
        version: 1, queueCutoff: null, queueSetSha256: HASH_A, receiptSetSha256: HASH_A, epochChecksumSha256: HASH_A,
      },
      censusVector: {
        version: 1,
        domains: domainVector((domain, index) => ({ domain, recordCount: index, prefixSha256: fakeHash("c" + domain) })),
        contentSha256: HASH_A,
      },
      canonicalDelta: {
        version: 1,
        domains: domainVector((domain, index) => ({ domain, recordCount: index, terminalIdentitySha256: fakeHash("d" + domain) })),
      },
      classCoverage: MIGRATION_MISMATCH_CLASSES.map((mismatchClass) => ({ class: mismatchClass, ran: true })),
      publicProbeSha256: HASH_A,
      publicProbeCoverage: MIGRATION_PUBLIC_PROBE_ORDER.map((probe) => ({ probe, ran: true })),
      sampleParameters: { version: 1, strideOrdinal: 97, sampleCount: 32, seedBasisSha256: HASH_A },
      mismatches: truncated, mismatchTotals,
    })).not.toThrow();
  });
});

describe("verifyMigrationGeneration: destination identity comparison", () => {
  it("refuses a same-data, different-identity destination (wrong database / restored clone)", async () => {
    stubDestinationPrimitives();
    const copySource = fakeCopySource();
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(copySource, runtime);
    await expect(verifyMigrationGeneration(
      baseInput({ homeDir: "/tmp/lcm-verify-identity-drift", expectedDestinationIdentitySha256: "b".repeat(64) }),
      dependencies,
    )).rejects.toMatchObject({ reason: "destination-drift" });
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });
});

describe("verifyMigrationGeneration: sealed manifest identity binding", () => {
  it("refuses a destination whose live witness and caller input agree but differ from the manifest's destination identity", async () => {
    // The live witness and expectedDestinationIdentitySha256 are both HASH_A,
    // so only the manifest binding can refuse: a caller deriving its
    // expectation from the connected database must not mint evidence for a
    // destination other than the one the copy recorded.
    const manifest = stubDestinationPrimitives();
    const recordedManifest = manifest.current;
    manifest.current = {
      ...recordedManifest, destination: { ...recordedManifest.destination, identitySha256: "b".repeat(64) },
    };
    const copySource = fakeCopySource();
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(copySource, runtime);
    const persistSpy = vi.spyOn(MigrationVerificationReportStore.prototype, "persist");
    await expect(verifyMigrationGeneration(
      baseInput({ homeDir: "/tmp/lcm-verify-manifest-identity-drift" }), dependencies,
    )).rejects.toMatchObject({ reason: "destination-drift", message: expect.stringContaining("sealed manifest") });
    expect(persistSpy).not.toHaveBeenCalled();
    expect(runtime.openReadOnlySnapshot).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(manifest.current.phase).toBe("copied");
  });
});

describe("verifyMigrationGeneration: system-identifier comparison", () => {
  it("refuses a destination whose live pg_control_system() system identifier does not match the expected value", async () => {
    stubDestinationPrimitives();
    const copySource = fakeCopySource();
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(copySource, runtime);
    await expect(verifyMigrationGeneration(
      baseInput({ homeDir: "/tmp/lcm-verify-system-identifier-drift", expectedSystemIdentifier: "9999999999" }),
      dependencies,
    )).rejects.toMatchObject({ reason: "destination-drift" });
  });

  it("refuses when the caller's expected identifier equals the live cluster but the copy recorded another", async () => {
    // The caller re-reads its expectation from the live destination after a
    // physical cluster change, so expected === live; only the identifier the
    // copy recorded in the manifest can still tell the clusters apart.
    const manifest = stubDestinationPrimitives();
    const recorded = manifest.current;
    manifest.current = {
      ...recorded, destination: { ...recorded.destination, systemIdentifier: "7000000001" },
    };
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(fakeCopySource(), runtime);
    const persistSpy = vi.spyOn(MigrationVerificationReportStore.prototype, "persist");
    await expect(verifyMigrationGeneration(
      baseInput({ homeDir: "/tmp/lcm-verify-recorded-system-identifier-drift", expectedSystemIdentifier: "7123456789" }),
      dependencies,
    )).rejects.toMatchObject({
      reason: "destination-drift", message: expect.stringContaining("sealed manifest"),
    });
    expect(persistSpy).not.toHaveBeenCalled();
    expect(runtime.openReadOnlySnapshot).not.toHaveBeenCalled();
  });

  it("refuses a manifest written before the copy recorded the destination system identifier", async () => {
    const manifest = stubDestinationPrimitives();
    const { systemIdentifier: _omitted, ...legacyDestination } = manifest.current.destination;
    manifest.current = { ...manifest.current, destination: legacyDestination };
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(fakeCopySource(), runtime);
    await expect(verifyMigrationGeneration(
      baseInput({ homeDir: "/tmp/lcm-verify-legacy-system-identifier" }), dependencies,
    )).rejects.toMatchObject({
      reason: "destination-drift",
      message: expect.stringContaining("copy did not record the destination system identifier"),
    });
    expect(runtime.openReadOnlySnapshot).not.toHaveBeenCalled();
  });

  it("compares the recorded identifier before the caller's expectation", () => {
    const live = { version: 1 as const, sealedWitnessSha256: HASH_A, systemIdentifier: "7123456789" };
    const expected = { expectedDestinationIdentitySha256: HASH_A, expectedSystemIdentifier: "7123456789" };
    expect(() => assertDestinationIdentityMatches(live, expected, HASH_A, "7123456789")).not.toThrow();
    expect(() => assertDestinationIdentityMatches(live, expected, HASH_A, "7000000001"))
      .toThrow("does not match the sealed manifest");
    expect(() => assertDestinationIdentityMatches(live, expected, HASH_A, undefined))
      .toThrow("copy did not record");
    expect(() => assertDestinationIdentityMatches(
      live, { ...expected, expectedSystemIdentifier: "9999999999" }, HASH_A, "7123456789",
    )).toThrow("does not match the expected value");
  });
});

describe("verifyMigrationGeneration: source reauthentication (witness-audit source-witness comparator)", () => {
  it("refuses when reauthenticate detects the source changed between the two calls", async () => {
    // copySource.reauthenticate() is called twice: once right after the
    // source opens, once after streaming completes. The witness audit
    // names copy-source.ts's refuse() as sourceWitness's refusal and
    // reauthenticateHeld's canonicalJson equality as its comparator; this
    // proves the driver actually propagates that refusal rather than
    // swallowing it or only checking once. A fixture where the second
    // call, not the first, throws is the one that can actually fail: a
    // driver that dropped the second reauthenticate() call entirely would
    // still pass a fixture where only the first call is made to throw.
    let calls = 0;
    const copySource = fakeCopySource({
      reauthenticate: async () => {
        calls += 1;
        if (calls === 2) throw new Error("migration copy source authority does not match");
      },
    });
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(copySource, runtime);
    await expect(verifyMigrationGeneration(
      baseInput({ homeDir: "/tmp/lcm-verify-source-reauthentication-drift" }),
      dependencies,
    )).rejects.toThrow("migration copy source authority does not match");
    expect(calls).toBe(2);
    // Never reached runtime creation, since the second reauthenticate()
    // call sits before it in the driver's own ordering.
    expect(runtime.close).not.toHaveBeenCalled();
  });
});

describe("verifyMigrationGeneration: sequence self-consistency (P0)", () => {
  it("catches a reset sequence even though the census and every canonical digest are identical to a healthy fixture", async () => {
    stubDestinationPrimitives();
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;

    const healthySession = fakeSession({ sequenceState: { conversations: { maxValue: "500", lastValue: "500" } } });
    const healthyRuntime = fakeRuntime({ session: healthySession });
    const healthyResult = await verifyMigrationGeneration(
      baseInput({ homeDir: "/tmp/lcm-verify-sequence-healthy" }),
      dependenciesFor(fakeCopySource({ recordCounts }), healthyRuntime),
    );
    expect(healthyResult.outcome).toBe("clean");

    const resetSession = fakeSession({ sequenceState: { conversations: { maxValue: "500", lastValue: "10" } } });
    const resetRuntime = fakeRuntime({ session: resetSession });
    const resetResult = await verifyMigrationGeneration(
      baseInput({ homeDir: "/tmp/lcm-verify-sequence-reset" }),
      dependenciesFor(fakeCopySource({ recordCounts }), resetRuntime),
    );
    expect(resetResult.outcome).toBe("mismatches");
    expect(resetResult.report.mismatches).toEqual([
      { domain: "conversations", class: "sequence", identitySha256: expect.any(String) },
    ]);
    // The census vector -- the count/digest equality class -- is byte
    // identical between the healthy and reset runs: only the sequence
    // self-consistency bound differs. This is the pairing that proves the
    // class catches what census equality structurally cannot.
    expect(resetResult.report.body.censusVector).toEqual(healthyResult.report.body.censusVector);
    expect(resetResult.report.body.canonicalDelta).toEqual(healthyResult.report.body.canonicalDelta);
  }, 15000);
});

describe("verifyMigrationGeneration: public listing probe", () => {
  it("produces no mismatch when the repository's real read path agrees with the source's canonical order", async () => {
    stubDestinationPrimitives();
    // conversations is domain-order index 3, so three records keep this
    // domain's census in step with stubDestinationPrimitives' default
    // recordCount-equals-index census, leaving the report clean except for
    // whatever the probe itself decides.
    const conversationsRecords = [
      fakeConversationRecord("2026-01-01T00:00:00.111000Z", "first"),
      fakeConversationRecord("2026-01-02T00:00:00.222000Z", "second"),
      fakeConversationRecord("2026-01-03T00:00:00.333000Z", "third"),
    ];
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const copySource = fakeCopySource({ recordCounts, conversationsRecords });
    const runtime = fakeRuntime({
      conversationsRows: [
        { conversation_id: "1", session_id: "first", title: null, bootstrapped_at: null, created_at: "2026-01-01T00:00:00.111Z", updated_at: "2026-01-01T00:00:00.111Z" },
        { conversation_id: "2", session_id: "second", title: null, bootstrapped_at: null, created_at: "2026-01-02T00:00:00.222Z", updated_at: "2026-01-02T00:00:00.222Z" },
        { conversation_id: "3", session_id: "third", title: null, bootstrapped_at: null, created_at: "2026-01-03T00:00:00.333Z", updated_at: "2026-01-03T00:00:00.333Z" },
      ],
    });
    const result = await verifyMigrationGeneration(
      baseInput({ homeDir: "/tmp/lcm-verify-probe-clean" }),
      dependenciesFor(copySource, runtime),
    );
    expect(result.outcome).toBe("clean");
    expect(result.report.mismatches.some((mismatch) => mismatch.domain === "public-listing")).toBe(false);
  }, 15000);

  it("records a sample-class mismatch through the real repository path when the destination listing diverges from the source", async () => {
    stubDestinationPrimitives();
    const conversationsRecords = [
      fakeConversationRecord("2026-01-01T00:00:00.111000Z", "first"),
      fakeConversationRecord("2026-01-02T00:00:00.222000Z", "second"),
      fakeConversationRecord("2026-01-03T00:00:00.333000Z", "third"),
    ];
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const copySource = fakeCopySource({ recordCounts, conversationsRecords });
    // The repository returns only one conversation instead of two: this is
    // the class of bug a hand-rolled SQL re-implementation of the same
    // ORDER BY could never catch, since it would share the same bug.
    const runtime = fakeRuntime({
      conversationsRows: [
        { conversation_id: "1", session_id: "first", title: null, bootstrapped_at: null, created_at: "2026-01-01T00:00:00.111Z", updated_at: "2026-01-01T00:00:00.111Z" },
      ],
    });
    const result = await verifyMigrationGeneration(
      baseInput({ homeDir: "/tmp/lcm-verify-probe-divergent" }),
      dependenciesFor(copySource, runtime),
    );
    expect(result.outcome).toBe("mismatches");
    // Schema v3.3 section 6.1: pinned to exactly the sampled record's
    // portable identity digest plus its canonical ordinal. The first
    // divergence is at ordinal 1 (the destination's "second" row is
    // missing), so the sampled record is the source's "second" entry --
    // never a hash of the two aggregate probe digests.
    const secondRecordIdentitySha256 = conversationIdentity("second", "2026-01-02T00:00:00.222000Z").identitySha256;
    expect(result.report.mismatches).toEqual([
      {
        domain: "public-listing", class: "sample",
        identitySha256: migrationWitnessSha256(["sample", secondRecordIdentitySha256, 1]),
      },
    ]);
  }, 15000);

  it("round-4 red case: catches a same-millisecond title swap that truncated-createdAt-only equality is blind to", async () => {
    // Round-4 P2: listConversations() orders ties by the destination's
    // native conversation_id, a different identity space from the
    // source's portable identitySha256 -- so before this fix, the digest
    // compared only truncateToMillisecondIso(createdAt) on both sides,
    // which cannot see two same-millisecond rows swap content, because
    // both sides reduce to the identical array [t1, t1] regardless of
    // which row holds which content. "first" and "second" share exactly
    // the same truncated millisecond here on purpose; the destination
    // returns neither of their real titles ("Alpha", "Beta") at either
    // position, which is undetectable by createdAt alone but must be
    // caught once title is folded into the comparison on both sides.
    stubDestinationPrimitives();
    const conversationsRecords = [
      fakeConversationRecord("2026-01-01T00:00:00.111000Z", "first", "Alpha"),
      fakeConversationRecord("2026-01-01T00:00:00.111000Z", "second", "Beta"),
      fakeConversationRecord("2026-01-03T00:00:00.333000Z", "third"),
    ];
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const copySource = fakeCopySource({ recordCounts, conversationsRecords });
    const runtime = fakeRuntime({
      conversationsRows: [
        { conversation_id: "1", session_id: "first", title: "Wrong", bootstrapped_at: null, created_at: "2026-01-01T00:00:00.111Z", updated_at: "2026-01-01T00:00:00.111Z" },
        { conversation_id: "2", session_id: "second", title: "Wrong", bootstrapped_at: null, created_at: "2026-01-01T00:00:00.111Z", updated_at: "2026-01-01T00:00:00.111Z" },
        { conversation_id: "3", session_id: "third", title: null, bootstrapped_at: null, created_at: "2026-01-03T00:00:00.333Z", updated_at: "2026-01-03T00:00:00.333Z" },
      ],
    });
    const result = await verifyMigrationGeneration(
      baseInput({ homeDir: "/tmp/lcm-verify-probe-title-swap" }),
      dependenciesFor(copySource, runtime),
    );
    expect(result.outcome).toBe("mismatches");
    expect(result.report.mismatches.some((mismatch) => mismatch.domain === "public-listing")).toBe(true);
  }, 15000);

  it("round-4 candidate-review-4 P1 red case: a healthy copy whose tie-break order disagrees between source and destination is not a mismatch", async () => {
    // The false positive both reviewers found: the source breaks a
    // same-millisecond tie by portable identity, the destination by its own
    // native conversation_id (assigned in copy order). The destination here
    // lists the two rows in the reverse of the source's identity order, so
    // a positional comparison would flag a copy that is correct; the
    // grouped multiset of [identity, title] pairs must not.
    stubDestinationPrimitives();
    const createdAt = "2026-01-01T00:00:00.111000Z";
    const alpha = { session: "alpha", title: "Alpha Title" };
    const beta = { session: "beta", title: "Beta Title" };
    const identityOf = (entry: typeof alpha) => conversationIdentity(entry.session, createdAt, entry.title).identitySha256;
    const sourceOrder = [alpha, beta].sort((left, right) => (identityOf(left) < identityOf(right) ? -1 : 1));
    const destinationOrder = [...sourceOrder].reverse();
    const conversationsRecords = [alpha, beta].map((entry) => fakeConversationRecord(createdAt, entry.session, entry.title));
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const copySource = fakeCopySource({ recordCounts, conversationsRecords });
    const runtime = fakeRuntime({
      conversationsRows: destinationOrder.map((entry, index) => ({
        conversation_id: String(index + 1), session_id: entry.session, title: entry.title, bootstrapped_at: null,
        created_at: "2026-01-01T00:00:00.111Z", updated_at: "2026-01-01T00:00:00.111Z",
      })),
    });
    const result = await verifyMigrationGeneration(
      baseInput({ homeDir: "/tmp/lcm-verify-probe-healthy-tie-order" }),
      dependenciesFor(copySource, runtime),
    );
    expect(result.report.mismatches.some((mismatch) => mismatch.domain === "public-listing")).toBe(false);
  }, 15000);

  describe("listing identity (#1417)", () => {
    const createdAt = "2026-01-01T00:00:00.111000Z";
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const destinationRow = (
      id: number, session: string, title: string | null, created: string = "2026-01-01T00:00:00.111Z",
    ) => ({
      conversation_id: String(id), session_id: session, title, bootstrapped_at: null, created_at: created, updated_at: created,
    });
    async function listingMismatch(
      conversationsRecords: ReadonlyArray<ReturnType<typeof fakeConversationRecord>>,
      runtimeOverrides: Parameters<typeof fakeRuntime>[0],
    ) {
      stubDestinationPrimitives();
      const result = await inspectMigrationVerification(
        baseInput({ homeDir: "/tmp/lcm-verify-listing-identity" }),
        dependenciesFor(fakeCopySource({ recordCounts, conversationsRecords }), fakeRuntime(runtimeOverrides)),
      );
      return result.mismatches.filter((mismatch) => mismatch.domain === "public-listing");
    }

    it("flags two sessions that traded titles inside one millisecond, which the title multiset alone cannot see", async () => {
      const mismatches = await listingMismatch(
        [fakeConversationRecord(createdAt, "session-a", "Alpha"), fakeConversationRecord(createdAt, "session-b", "Beta")],
        { conversationsRows: [destinationRow(1, "session-a", "Beta"), destinationRow(2, "session-b", "Alpha")] },
      );
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]).toMatchObject({ domain: "public-listing", class: "sample" });
    });

    it("flags a public read path that returns another row's title for a correctly copied header", async () => {
      // The identity read sees the right headers; only the repository's
      // listing (the public read path under test) hands back swapped titles.
      const mismatches = await listingMismatch(
        [fakeConversationRecord(createdAt, "session-a", "Alpha"), fakeConversationRecord(createdAt, "session-b", "Beta")],
        {
          conversationsRows: [destinationRow(1, "session-a", "Beta"), destinationRow(2, "session-b", "Alpha")],
          conversationHeaderRows: [
            destinationRow(1, "session-a", "Alpha", "2026-01-01T00:00:00.111000Z"),
            destinationRow(2, "session-b", "Beta", "2026-01-01T00:00:00.111000Z"),
          ],
        },
      );
      expect(mismatches).toHaveLength(1);
    });

    it("accepts the same identity and title pairs listed in the opposite tie order", async () => {
      const mismatches = await listingMismatch(
        [fakeConversationRecord(createdAt, "session-a", "Alpha"), fakeConversationRecord(createdAt, "session-b", "Beta")],
        { conversationsRows: [destinationRow(1, "session-b", "Beta"), destinationRow(2, "session-a", "Alpha")] },
      );
      expect(mismatches).toEqual([]);
    });

    it("numbers identical headers 0..n-1 so two indistinguishable conversations match the source's ordinals", async () => {
      const mismatches = await listingMismatch(
        [
          fakeConversationRecord(createdAt, "twin", "Same", 0), fakeConversationRecord(createdAt, "twin", "Same", 1),
          fakeConversationRecord(createdAt, "twin", "Same", 2),
        ],
        { conversationsRows: [destinationRow(1, "twin", "Same"), destinationRow(2, "twin", "Same"), destinationRow(3, "twin", "Same")] },
      );
      expect(mismatches).toEqual([]);
    });

    it("flags a destination that is missing one of several identical headers", async () => {
      const mismatches = await listingMismatch(
        [fakeConversationRecord(createdAt, "twin", "Same", 0), fakeConversationRecord(createdAt, "twin", "Same", 1)],
        { conversationsRows: [destinationRow(1, "twin", "Same")] },
      );
      expect(mismatches).toHaveLength(1);
    });

    it("matches a nonzero-microsecond timestamp through the to_char projection, not through a Date", async () => {
      const fine = "2026-01-01T00:00:00.111456Z";
      const records = [fakeConversationRecord(fine, "fine", "Fine")];
      // The repository's Date only carries the millisecond; the identity
      // read supplies the microseconds the fingerprint needs.
      const exact = await listingMismatch(records, {
        conversationsRows: [destinationRow(1, "fine", "Fine")],
        conversationHeaderRows: [destinationRow(1, "fine", "Fine", fine)],
      });
      expect(exact).toEqual([]);
      // Deriving the identity from the Date's zero-padded microseconds would
      // disagree with the source here; the headers are what the copy wrote.
      const padded = await listingMismatch(records, { conversationsRows: [destinationRow(1, "fine", "Fine")] });
      expect(padded).toHaveLength(1);
    });

    it("flags a listed row whose header cannot be read back by its conversation id", async () => {
      const mismatches = await listingMismatch(
        [fakeConversationRecord(createdAt, "session-a", "Alpha")],
        { conversationsRows: [destinationRow(1, "session-a", "Alpha")], conversationHeaderRows: [] },
      );
      expect(mismatches).toHaveLength(1);
    });

    it("orders rows that share the uncorrelated identity by title, so the digest does not depend on listing order", async () => {
      stubDestinationPrimitives();
      const rowsFor = (titles: ReadonlyArray<string | null>) => titles.map((title, index) => destinationRow(index + 1, "orphan", title));
      const digestFor = async (titles: ReadonlyArray<string | null>) => (await runOrderedListingProbe(
        fakeRuntime({ conversationsRows: rowsFor(titles), conversationHeaderRows: [] }) as never,
        projectId,
        [{ createdAt: "2026-01-01T00:00:00.111Z", identitySha256: "a".repeat(64), title: null }],
      ));
      const forward = await digestFor([null, "A", "B"]);
      const backward = await digestFor(["B", "A", null]);
      const shuffled = await digestFor(["A", null, "B"]);
      expect(forward.mismatch).not.toBeNull();
      expect(backward.publicListingSha256).toBe(forward.publicListingSha256);
      expect(shuffled.publicListingSha256).toBe(forward.publicListingSha256);
    });

    it("digests the sorted identity and title pairs per millisecond group under the v2 tag", async () => {
      stubDestinationPrimitives();
      const records = [fakeConversationRecord(createdAt, "session-a", "Alpha"), fakeConversationRecord(createdAt, "session-b", null)];
      const probe = await runOrderedListingProbe(
        fakeRuntime({ conversationsRows: [destinationRow(1, "session-a", "Alpha"), destinationRow(2, "session-b", null)] }) as never,
        projectId,
        records.map((record) => ({ createdAt: "2026-01-01T00:00:00.111Z", identitySha256: record.identitySha256, title: record.value.title })),
      );
      const pairs = records.map((record) => [record.identitySha256, record.value.title] as const)
        .sort((left, right) => (left[0] < right[0] ? -1 : 1));
      expect(probe.mismatch).toBeNull();
      expect(probe.publicListingSha256).toBe(createHash("sha256").update(canonicalJson(
        ["lcm-migration-verification-public-listing-v2", [["2026-01-01T00:00:00.111Z", pairs]]],
      ), "utf8").digest("hex"));
    });
  });

  it("round-4 candidate-review-4 P1: a tie group mixing a null title with a real one is not flagged for a healthy copy", async () => {
    // A multi-entry tie group where one title is null and the other is
    // real, listed by the destination in the reverse of the source's
    // order, for a healthy copy that must not be flagged.
    stubDestinationPrimitives();
    const conversationsRecords = [
      fakeConversationRecord("2026-01-01T00:00:00.111000Z", "untitled"),
      fakeConversationRecord("2026-01-01T00:00:00.111000Z", "titled", "Real Title"),
    ];
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const copySource = fakeCopySource({ recordCounts, conversationsRecords });
    const runtime = fakeRuntime({
      conversationsRows: [
        { conversation_id: "1", session_id: "titled", title: "Real Title", bootstrapped_at: null, created_at: "2026-01-01T00:00:00.111Z", updated_at: "2026-01-01T00:00:00.111Z" },
        { conversation_id: "2", session_id: "untitled", title: null, bootstrapped_at: null, created_at: "2026-01-01T00:00:00.111Z", updated_at: "2026-01-01T00:00:00.111Z" },
      ],
    });
    const result = await verifyMigrationGeneration(
      baseInput({ homeDir: "/tmp/lcm-verify-probe-null-title-tie" }),
      dependenciesFor(copySource, runtime),
    );
    expect(result.report.mismatches.some((mismatch) => mismatch.domain === "public-listing")).toBe(false);
  }, 15000);

  it("round-1 P1 red case: an empty source conversations listing against a non-empty destination records a sample mismatch instead of crashing", async () => {
    // Math.min(0, expectedOrder.length - 1) was Math.min(0, -1) = -1 when
    // the source listing was legitimately empty, and expectedOrder[-1] is
    // undefined -- reading .identitySha256 off it threw before the report
    // was ever built. A legitimately empty domain must produce evidence,
    // not a crash.
    stubDestinationPrimitives({
      domainCensus: (domain) => (domain === "conversations"
        ? { domain, recordCount: 0, prefixSha256: fakeHash("prefix-conversations-0"), terminalIdentitySha256: null }
        : { domain, recordCount: PORTABLE_RECORD_DOMAIN_ORDER.indexOf(domain), prefixSha256: fakeHash(`prefix-${domain}-${PORTABLE_RECORD_DOMAIN_ORDER.indexOf(domain)}`), terminalIdentitySha256: PORTABLE_RECORD_DOMAIN_ORDER.indexOf(domain) === 0 ? null : HASH_A }),
    });
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => [domain, domain === "conversations" ? 0 : PORTABLE_RECORD_DOMAIN_ORDER.indexOf(domain)])) as Partial<Record<PortableDomain, number>>;
    const copySource = fakeCopySource({ recordCounts, conversationsRecords: [] });
    const runtime = fakeRuntime({
      conversationsRows: [
        { conversation_id: "1", session_id: "orphan", title: null, bootstrapped_at: null, created_at: "2026-01-01T00:00:00.111Z", updated_at: "2026-01-01T00:00:00.111Z" },
      ],
    });
    const result = await verifyMigrationGeneration(
      baseInput({ homeDir: "/tmp/lcm-verify-probe-empty-source" }),
      dependenciesFor(copySource, runtime),
    );
    expect(result.outcome).toBe("mismatches");
    expect(result.report.mismatches).toContainEqual({
      domain: "public-listing", class: "sample",
      identitySha256: MIGRATION_SAMPLE_EMPTY_SOURCE_IDENTITY_SHA256,
    });
  }, 15000);
});

describe("verifyMigrationGeneration: search self-match probe (round-2 P1)", () => {
  it("round-2 P1 red case: a destination whose search configuration is wrong -- everything else intact -- marks sample not-run and refuses eligibility, without throwing", async () => {
    // The owner's own fixture: search_v1 is broken in a way that leaves
    // every digest comparison agreeing (no listing drift, no census
    // drift, nothing else touched), so the ONLY signal a real operator
    // would have that something is wrong is that publicProbeCoverage's
    // public-search entry is false and activationEligible is false, on
    // an otherwise "clean" (zero-mismatch) report. classCoverage's
    // sample bit stays true, since listing (the other half of that
    // class) ran fine -- the two probes have independent coverage.
    stubDestinationPrimitives();
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const copySource = fakeCopySource({ recordCounts });
    // searchRows: [] means every search_v1 query -- for every candidate
    // in the pool, regardless of content -- returns nothing, simulating
    // a broken or misconfigured search path while every other read
    // (schema, census, ledger, sequence) is untouched.
    const runtime = fakeRuntime({ searchRows: [] });
    const dependencies = dependenciesFor(copySource, runtime);
    const result = await verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-search-broken" }), dependencies);
    expect(result.outcome).toBe("clean");
    expect(result.report.mismatches).toEqual([]);
    expect(result.report.body.classCoverage).toContainEqual({ class: "sample", ran: true });
    expect(result.report.body.publicProbeCoverage).toContainEqual({ probe: "public-search", ran: false });
    expect(result.report.activationEligible).toBe(false);
  }, 15000);

  it("finds a message searching for its own content and marks public-search ran, folding the outcome into publicProbeSha256", async () => {
    stubDestinationPrimitives();
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    // Two distinct candidates so a different seed can land on a
    // different one: HASH_A's leading hex ("aaaaaaaa") is even, landing
    // on ordinal 0; "b" x 64's leading hex ("bbbbbbbb") is odd, landing
    // on ordinal 1 -- both match on the first try against the default
    // fakeRuntime, which returns a hit for any query.
    const messagesRecords = [fakeMessageRecord("first candidate body", "one"), fakeMessageRecord("second candidate body", "two")];
    const copySource = fakeCopySource({ recordCounts, messagesRecords });
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(copySource, runtime);
    const result = await verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-search-self-match" }), dependencies);
    expect(result.report.body.publicProbeCoverage).toContainEqual({ probe: "public-search", ran: true });
    expect(result.report.activationEligible).toBe(true);
    // Changing which candidate the walk lands on (via a different
    // seedBasisSha256) changes the digest: the outcome is genuinely
    // folded in, not a constant regardless of what happened.
    stubDestinationPrimitives();
    const differentSeed = await verifyMigrationGeneration(
      baseInput({ homeDir: "/tmp/lcm-verify-search-self-match-2", sampleParameters: { version: 1, strideOrdinal: 97, sampleCount: 32, seedBasisSha256: "b".repeat(64) } }),
      dependenciesFor(fakeCopySource({ recordCounts, messagesRecords }), fakeRuntime()),
    );
    expect(differentSeed.report.body.publicProbeSha256).not.toBe(result.report.body.publicProbeSha256);
  }, 15000);

  it("#1676 named negative: an empty candidate pool with a non-zero messages checkpoint and census never earns public-search", async () => {
    // The pool is empty only because the fake stream yielded no message
    // records; the checkpoint and the destination census still say four
    // messages exist. Pool-empty alone must not earn the receipt.
    stubDestinationPrimitives();
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const copySource = fakeCopySource({ recordCounts, messagesRecords: [] });
    // searchRows: [] so the empty-source search is clean and only the
    // non-zero checkpoint and census can refuse the receipt.
    const runtime = fakeRuntime({ searchRows: [] });
    const dependencies = dependenciesFor(copySource, runtime);
    const result = await verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-search-no-messages" }), dependencies);
    expect(result.report.body.publicProbeCoverage).toContainEqual({ probe: "public-search", ran: false });
    expect(result.report.activationEligible).toBe(false);
  }, 15000);

  describe("#1676 empty project: the empty-source search witness", () => {
    const MESSAGES_INDEX = PORTABLE_RECORD_DOMAIN_ORDER.indexOf("messages");
    const countFor = (domain: PortableDomain, messageCount: number): number => (
      domain === "messages" ? messageCount : PORTABLE_RECORD_DOMAIN_ORDER.indexOf(domain)
    );
    /** An internally consistent project whose messages domain is empty on the source, the manifest, the ledger and the census. */
    async function verifyEmptyProject(options: {
      home: string;
      sourceMessageCount?: number;
      censusMessageCount?: number;
      runtime?: Parameters<typeof fakeRuntime>[0];
    }) {
      const sourceMessageCount = options.sourceMessageCount ?? 0;
      const censusMessageCount = options.censusMessageCount ?? 0;
      const ledgerCheckpoints = PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => ({
        ...defaultLedgerCheckpoint(domain), ordinal: countFor(domain, censusMessageCount), recordCount: countFor(domain, censusMessageCount),
      }));
      stubDestinationPrimitives({
        manifestCheckpoints: ledgerCheckpoints,
        domainCensus: (domain) => {
          const count = countFor(domain, censusMessageCount);
          return {
            domain, recordCount: count, prefixSha256: fakeHash(`prefix-${domain}-${count}`),
            terminalIdentitySha256: count === 0 ? null : HASH_A,
          };
        },
      });
      const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => [domain, countFor(domain, sourceMessageCount)])) as Partial<Record<PortableDomain, number>>;
      const session = fakeSession({
        ledgerCheckpoints,
        ledgerIdentityTotal: LEDGER_TOTAL_RECORD_COUNT_DEFAULT - MESSAGES_INDEX + censusMessageCount,
      });
      return verifyMigrationGeneration(
        baseInput({ homeDir: options.home }),
        dependenciesFor(
          fakeCopySource({ recordCounts, messagesRecords: [] }),
          fakeRuntime({ session, searchRows: [], ...options.runtime }),
        ),
      );
    }
    const SEARCH_HIT_ROW = {
      message_id: 1, conversation_id: 1, role: "user", snippet: "match",
      created_at: "2026-01-01T00:00:00.000Z", rank: 1, match_phase: 0,
    };

    it("earns public-search and activation eligibility when source, census and the production search all agree the project is empty", async () => {
      const result = await verifyEmptyProject({ home: "/tmp/lcm-verify-empty-project" });
      expect(result.report.mismatches).toEqual([]);
      expect(result.outcome).toBe("clean");
      expect(result.report.body.publicProbeCoverage).toContainEqual({ probe: "public-search", ran: true });
      expect(result.report.activationEligible).toBe(true);
    }, 15000);

    it("folds a distinct digest: the empty-source pass differs from a self-match pass and from every non-earning pass on the same zero fixture", async () => {
      const empty = await verifyEmptyProject({ home: "/tmp/lcm-verify-empty-digest" });
      const noRun = await verifyEmptyProject({ home: "/tmp/lcm-verify-empty-digest-no-run", runtime: { transferRunId: null } });
      const incomplete = await verifyEmptyProject({ home: "/tmp/lcm-verify-empty-digest-incomplete", runtime: { transferRunState: "active" } });
      const rows = await verifyEmptyProject({ home: "/tmp/lcm-verify-empty-digest-rows", runtime: { searchRows: [SEARCH_HIT_ROW] } });
      stubDestinationPrimitives();
      const selfMatch = await verifyMigrationGeneration(
        baseInput({ homeDir: "/tmp/lcm-verify-empty-digest-self-match" }),
        dependenciesFor(fakeCopySource({
          recordCounts: Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>,
        }), fakeRuntime()),
      );
      const digests = [empty, noRun, incomplete, rows, selfMatch].map((entry) => entry.report.body.publicProbeSha256);
      expect(new Set(digests).size).toBe(digests.length);
    }, 30000);

    it("withholds the receipt when no transfer run exists or the run is not completed", async () => {
      for (const [home, runtime] of [
        ["/tmp/lcm-verify-empty-no-run", { transferRunId: null }],
        ["/tmp/lcm-verify-empty-incomplete-run", { transferRunState: "active" }],
      ] as const) {
        const result = await verifyEmptyProject({ home, runtime });
        expect(result.report.body.publicProbeCoverage).toContainEqual({ probe: "public-search", ran: false });
        expect(result.report.activationEligible).toBe(false);
      }
    }, 30000);

    it("withholds the receipt when the production search returns a row for an empty project", async () => {
      const result = await verifyEmptyProject({ home: "/tmp/lcm-verify-empty-search-row", runtime: { searchRows: [SEARCH_HIT_ROW] } });
      expect(result.report.body.publicProbeCoverage).toContainEqual({ probe: "public-search", ran: false });
      expect(result.report.activationEligible).toBe(false);
    }, 15000);

    it("withholds the receipt and refuses eligibility when the fenced census holds messages the source did not have", async () => {
      const result = await verifyEmptyProject({ home: "/tmp/lcm-verify-empty-census-nonzero", censusMessageCount: 3 });
      expect(result.report.body.publicProbeCoverage).toContainEqual({ probe: "public-search", ran: false });
      expect(result.report.activationEligible).toBe(false);
      expect(result.report.mismatches.some((mismatch) => mismatch.domain === "messages")).toBe(true);
    }, 15000);

    it("withholds the receipt when the source stream yielded no candidates but its messages checkpoint is non-zero", async () => {
      const result = await verifyEmptyProject({ home: "/tmp/lcm-verify-empty-checkpoint-nonzero", sourceMessageCount: 3, censusMessageCount: 3 });
      expect(result.report.body.publicProbeCoverage).toContainEqual({ probe: "public-search", ran: false });
      expect(result.report.activationEligible).toBe(false);
    }, 15000);

    it("withholds the receipt when the source checkpoint is non-zero even though the census is zero and the search is clean", async () => {
      const result = await verifyEmptyProject({ home: "/tmp/lcm-verify-empty-checkpoint-only", sourceMessageCount: 3, censusMessageCount: 0 });
      expect(result.report.body.publicProbeCoverage).toContainEqual({ probe: "public-search", ran: false });
      expect(result.report.activationEligible).toBe(false);
    }, 15000);

    it("does not let the number of returned rows reach publicProbeSha256", async () => {
      const second = { ...SEARCH_HIT_ROW, message_id: 2 };
      const one = await verifyEmptyProject({ home: "/tmp/lcm-verify-empty-one-row", runtime: { searchRows: [SEARCH_HIT_ROW] } });
      const two = await verifyEmptyProject({ home: "/tmp/lcm-verify-empty-two-rows", runtime: { searchRows: [SEARCH_HIT_ROW, second] } });
      for (const result of [one, two]) {
        expect(result.report.body.publicProbeCoverage).toContainEqual({ probe: "public-search", ran: false });
      }
      expect(two.report.body.publicProbeSha256).toBe(one.report.body.publicProbeSha256);
    }, 30000);

    it("propagates a search error instead of folding it into a pass", async () => {
      const runtime = fakeRuntime({ session: fakeSession(), searchRows: [] });
      // Only the production full-text statement fails; every other read keeps working.
      const failing = {
        ...runtime,
        transaction: vi.fn(async (callback: (executor: unknown) => Promise<unknown>) => runtime.transaction(async (executor: unknown) => callback({
          query: async (config: { text: string }) => {
            if (config.text.includes("WITH input AS MATERIALIZED")) throw new Error("search backend down");
            return (executor as { query: (config: unknown) => Promise<unknown> }).query(config);
          },
        }))),
      };
      stubDestinationPrimitives();
      const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => [domain, countFor(domain, 0)])) as Partial<Record<PortableDomain, number>>;
      await expect(verifyMigrationGeneration(
        baseInput({ homeDir: "/tmp/lcm-verify-empty-search-error" }),
        dependenciesFor(fakeCopySource({ recordCounts, messagesRecords: [] }), failing as never),
      )).rejects.toThrow("search backend down");
    }, 15000);
  });

  it("caps the search-probe candidate pool at MIGRATION_SEARCH_PROBE_CANDIDATE_POOL_SIZE, still finding a match among the first N", async () => {
    stubDestinationPrimitives();
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    // One more message than the pool size: the (pool size + 1)-th
    // message must be counted (advancing messageOrdinal) but never
    // stored as a candidate, exercising the pool-size boundary the
    // single-message default fixture never reaches.
    const messagesRecords = Array.from(
      { length: MIGRATION_SEARCH_PROBE_CANDIDATE_POOL_SIZE + 1 },
      (_, index) => fakeMessageRecord(`candidate body ${index}`, `pool-${index}`),
    );
    const copySource = fakeCopySource({ recordCounts, messagesRecords });
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(copySource, runtime);
    const result = await verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-search-pool-cap" }), dependencies);
    expect(result.report.body.publicProbeCoverage).toContainEqual({ probe: "public-search", ran: true });
  }, 15000);

  it("round-4 P1 red case: a non-empty search result that is not the candidate's own message is never treated as a pass", async () => {
    // Pre-fix, "results.length > 0" alone made this ran:true on the
    // very first attempt -- exactly the defect a self-match probe
    // exists to catch: a search path that ignores its query, or always
    // returns some fixed unrelated row, would pass every attempt in
    // the pool. Here the destination search always returns a
    // well-formed, non-empty result (message_id 999), but never the
    // message_id the ledger names for the actual candidate tried
    // (native_key "1", per fakeRuntime's default correlation). The fix
    // must refuse to call this confirmed.
    stubDestinationPrimitives();
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const copySource = fakeCopySource({ recordCounts });
    const runtime = fakeRuntime({
      searchRows: [{
        message_id: 999, conversation_id: 1, role: "user", snippet: "unrelated",
        created_at: "2026-01-01T00:00:00.000Z", rank: 1, match_phase: 0,
      }],
    });
    const dependencies = dependenciesFor(copySource, runtime);
    const result = await verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-search-unrelated-result" }), dependencies);
    expect(result.report.body.publicProbeCoverage).toContainEqual({ probe: "public-search", ran: false });
    expect(result.report.activationEligible).toBe(false);
  }, 15000);

  it("round-4 red case: an unattributable candidate (no correlating ledger row) is never treated as a pass, even when the search result looks right", async () => {
    // Absence of a correlation row is not evidence that search works:
    // the default search rows here (message_id: 1) would confirm the
    // default candidate if correlation succeeded, but transferIdentities
    // is forced empty, so every lookup finds zero rows and the walk
    // must never reach, let alone accept, the search call's result.
    stubDestinationPrimitives();
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const copySource = fakeCopySource({ recordCounts });
    const runtime = fakeRuntime({ transferIdentities: [] });
    const dependencies = dependenciesFor(copySource, runtime);
    const result = await verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-search-unattributable" }), dependencies);
    expect(result.report.body.publicProbeCoverage).toContainEqual({ probe: "public-search", ran: false });
    expect(result.report.activationEligible).toBe(false);
  }, 15000);

  it("round-4 red case: no completed transfer run means every candidate is unattributable and the probe never confirms a match", async () => {
    stubDestinationPrimitives();
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const copySource = fakeCopySource({ recordCounts });
    const runtime = fakeRuntime({ transferRunId: null });
    const dependencies = dependenciesFor(copySource, runtime);
    const result = await verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-search-no-run" }), dependencies);
    expect(result.report.body.publicProbeCoverage).toContainEqual({ probe: "public-search", ran: false });
    expect(result.report.activationEligible).toBe(false);
  }, 15000);

  it("round-4 P2 red case: a transfer run that exists but is not completed is distinguished from no run at all", async () => {
    // The three-way-absence standard applied to the reason text, not
    // only the outcome: an in-progress copy's active run must not be
    // reported as "no transfer run was found" -- that reason is
    // reserved for the genuinely absent case (the previous test).
    stubDestinationPrimitives();
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const copySource = fakeCopySource({ recordCounts });
    const runtime = fakeRuntime({ transferRunState: "active" });
    const dependencies = dependenciesFor(copySource, runtime);
    const result = await verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-search-run-not-completed" }), dependencies);
    expect(result.report.body.publicProbeCoverage).toContainEqual({ probe: "public-search", ran: false });
    expect(result.report.activationEligible).toBe(false);
    expect(result.report.body.publicProbeSha256).not.toBe(
      (await verifyMigrationGeneration(
        baseInput({ homeDir: "/tmp/lcm-verify-search-run-not-completed-2" }),
        dependenciesFor(fakeCopySource({ recordCounts }), fakeRuntime({ transferRunId: null })),
      )).report.body.publicProbeSha256,
    );
  }, 15000);

  it("round-4 P1 red case: a candidate correlates through the copy's real JSON-array locator format, not a bare id", async () => {
    // The defect that made the probe unusable in production: native_key
    // is json_build_array(id::text)::text (e.g. '["1"]'), never a bare
    // "1" -- the copy's own dependency resolver (insertCanonicalRecord's
    // physical()) reads it back exactly that way. This fixture supplies
    // the raw locator format on purpose, exercising the same
    // ::json->>0 unwrap the production query performs, rather than a
    // pre-unwrapped value that could agree with buggy code by accident.
    stubDestinationPrimitives();
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const copySource = fakeCopySource({ recordCounts });
    const candidateIdentitySha256 = fakeHash("message-identity-default");
    const runtime = fakeRuntime({
      transferIdentities: [{ identitySha256: candidateIdentitySha256, nativeKey: JSON.stringify(["1"]) }],
    });
    const dependencies = dependenciesFor(copySource, runtime);
    const result = await verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-search-locator-format" }), dependencies);
    expect(result.report.body.publicProbeCoverage).toContainEqual({ probe: "public-search", ran: true });
    expect(result.report.activationEligible).toBe(true);
  }, 15000);

  it("kAKbI: confirms a candidate whose own message ranks below the first search result", async () => {
    // The candidate's own message is the third ranked row. A one-row
    // window would see only message 1 and leave the probe not-run on a
    // healthy destination, so the probe reads a wider fixed window.
    stubDestinationPrimitives();
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const searchRow = (messageId: number) => ({
      message_id: messageId, conversation_id: 1, role: "user", snippet: "match",
      created_at: "2026-01-01T00:00:00.000Z", rank: 1, match_phase: 0,
    });
    const runtime = fakeRuntime({
      searchRows: [searchRow(1), searchRow(2), searchRow(3)],
      transferIdentities: [{ identitySha256: fakeHash("message-identity-default"), nativeKey: JSON.stringify(["3"]) }],
    });
    const result = await verifyMigrationGeneration(
      baseInput({ homeDir: "/tmp/lcm-verify-search-window" }), dependenciesFor(fakeCopySource({ recordCounts }), runtime),
    );
    expect(result.report.body.publicProbeCoverage).toContainEqual({ probe: "public-search", ran: true });
    expect(result.report.activationEligible).toBe(true);
  }, 15000);

  it("kAKbI: a candidate whose own message is outside the window stays not-run rather than passing", async () => {
    stubDestinationPrimitives();
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const runtime = fakeRuntime({
      transferIdentities: [{ identitySha256: fakeHash("message-identity-default"), nativeKey: JSON.stringify(["999"]) }],
    });
    const result = await verifyMigrationGeneration(
      baseInput({ homeDir: "/tmp/lcm-verify-search-window-miss" }), dependenciesFor(fakeCopySource({ recordCounts }), runtime),
    );
    expect(result.report.body.publicProbeCoverage).toContainEqual({ probe: "public-search", ran: false });
    expect(result.report.activationEligible).toBe(false);
  }, 15000);

  it("round-2 P1 red case: a listing mismatch alongside a not-run search probe retains the mismatch and still refuses eligibility", async () => {
    // The compound case the owner explicitly did not want handled by
    // suppression: a genuine listing drift and a broken search path in
    // the same pass. Because publicProbeCoverage tracks the search
    // probe's liveness independently of classCoverage's "sample" bit
    // (which now reflects only whether listing ran, which is always),
    // the listing mismatch is retained as real operator evidence AND
    // activationEligible is refused via public-search: false -- neither
    // property is sacrificed for the other, and the validator's "a
    // not-run class must have zero evidence" rule is never even
    // approached, because classCoverage's sample bit is true here.
    stubDestinationPrimitives();
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const conversationsRecords = [fakeConversationRecord("2026-01-01T00:00:00.111000Z", "first")];
    const copySource = fakeCopySource({ recordCounts, conversationsRecords });
    const runtime = fakeRuntime({
      searchRows: [],
      conversationsRows: [
        { conversation_id: "1", session_id: "different", title: null, bootstrapped_at: null, created_at: "2026-02-02T00:00:00.222Z", updated_at: "2026-02-02T00:00:00.222Z" },
      ],
    });
    const dependencies = dependenciesFor(copySource, runtime);
    const result = await verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-search-and-listing-both-broken" }), dependencies);
    expect(result.report.mismatches.some((mismatch) => mismatch.domain === "public-listing" && mismatch.class === "sample")).toBe(true);
    expect(result.report.body.classCoverage).toContainEqual({ class: "sample", ran: true });
    expect(result.report.body.publicProbeCoverage).toContainEqual({ probe: "public-search", ran: false });
    expect(result.report.activationEligible).toBe(false);
  }, 15000);
});

describe("verifyMigrationGeneration: completion receipts (#1396)", () => {
  const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
  // Each case names the one comparator group that is never invoked and the
  // coverage bits that may therefore no longer claim to have run.
  const skipCases: ReadonlyArray<readonly [MigrationVerificationReceiptId, readonly string[], readonly string[]]> = [
    ["count-digest", ["count", "digest"], []],
    ["identity", ["identity"], []],
    ["schema", ["schema"], []],
    ["sequence", ["sequence"], []],
    ["relation", ["relation"], []],
    ["ledger", ["ledger"], []],
    ["public-listing", ["sample"], ["public-listing"]],
    ["public-search", [], ["public-search"]],
  ];

  it.each(skipCases)(
    "a skipped %s comparator leaves exactly its bits not run, refuses eligibility and still persists the report",
    async (receipt, notRunClasses, notRunProbes) => {
      const manifest = stubDestinationPrimitives();
      const homeDir = mkdtempSync(join(tmpdir(), "lcm-verify-receipt-"));
      try {
        const result = await verifyMigrationGeneration(
          baseInput({ homeDir }),
          dependenciesFor(fakeCopySource({ recordCounts }), fakeRuntime(), { _skipComparatorsForTesting: new Set([receipt]) }),
        );
        expect(result.report.body.classCoverage).toEqual(MIGRATION_MISMATCH_CLASSES.map((mismatchClass) => ({
          class: mismatchClass, ran: !notRunClasses.includes(mismatchClass),
        })));
        expect(result.report.body.publicProbeCoverage).toEqual(MIGRATION_PUBLIC_PROBE_ORDER.map((probe) => ({
          probe, ran: !notRunProbes.includes(probe),
        })));
        // A skip is not a mismatch and not a failure: the report is clean
        // evidence of what ran, and is durably persisted as such.
        expect(result.outcome).toBe("clean");
        expect(result.report.mismatches).toEqual([]);
        expect(result.report.activationEligible).toBe(false);
        expect(new MigrationVerificationReportStore({ homeDir }).has("generation-1", result.report.reportSha256)).toBe(true);
        // Ineligible, so no manifest effect was begun or completed.
        expect(manifest.current.phase).toBe("copied");
      } finally {
        rmSync(homeDir, { recursive: true });
      }
    },
    15000,
  );

  it("a skip changes the report identity, so a partially run pass can never share a report with a complete one", async () => {
    stubDestinationPrimitives();
    const full = await inspectMigrationVerification(
      baseInput({ homeDir: "/tmp/lcm-verify-receipt-inspect" }), dependenciesFor(fakeCopySource({ recordCounts }), fakeRuntime()),
    );
    const partial = await inspectMigrationVerification(
      baseInput({ homeDir: "/tmp/lcm-verify-receipt-inspect" }),
      dependenciesFor(fakeCopySource({ recordCounts }), fakeRuntime(), { _skipComparatorsForTesting: new Set(["ledger"]) }),
    );
    expect(full.activationEligible).toBe(true);
    expect(partial.activationEligible).toBe(false);
    expect(partial.reportSha256).not.toBe(full.reportSha256);
  }, 15000);

  it("a search probe that ran but found no correlated self-match earns no receipt, while the listing probe keeps its own", async () => {
    stubDestinationPrimitives();
    const result = await inspectMigrationVerification(
      baseInput({ homeDir: "/tmp/lcm-verify-receipt-search-miss" }),
      dependenciesFor(fakeCopySource({ recordCounts }), fakeRuntime({ searchRows: [] })),
    );
    expect(result.body.publicProbeCoverage).toEqual([
      { probe: "public-listing", ran: true }, { probe: "public-search", ran: false },
    ]);
  }, 15000);
});

describe("completePendingMigrationVerification (plan-v5 Part B (2): the persisted-report completion, extracted unchanged)", () => {
  it("returns null, touching nothing, when no verify-generation effect is pending", () => {
    const manifest = fakeManifestStore();
    const before = manifest.current.checksumSha256;
    expect(completePendingMigrationVerification({ homeDir: "/tmp/lcm-verify-no-pending", generationId: MANIFEST_FIXTURE_GENERATION_ID })).toBeNull();
    expect(manifest.current.checksumSha256).toBe(before);
  });
});

describe("shared census and canonical-delta builders", () => {
  const domains = PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => ({
    domain, recordCount: index, prefixSha256: HASH_A, terminalIdentitySha256: index === 0 ? null : HASH_A,
  }));

  it("builds a frozen-schema census vector and canonical delta from one domain census", () => {
    const census = buildMigrationCensusVector(domains);
    const delta = buildMigrationCanonicalDelta(domains);
    expect(census.domains.map((entry) => entry.domain)).toEqual([...PORTABLE_RECORD_DOMAIN_ORDER]);
    expect(delta.domains.map((entry) => entry.recordCount)).toEqual(domains.map((entry) => entry.recordCount));
    // A domain without a terminal identity gets the deterministic empty sentinel, never null.
    expect(delta.domains[0]!.terminalIdentitySha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(delta.domains[1]!.terminalIdentitySha256).toBe(HASH_A);
  });
});
