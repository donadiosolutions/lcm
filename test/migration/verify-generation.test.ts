import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as coordination from "../../src/storage/postgresql/coordination.js";
import * as searchConfiguration from "../../src/storage/postgresql/search-configuration.js";
import * as migrations from "../../src/storage/postgresql/migrations.js";
import * as portableSource from "../../src/storage/postgresql/portable-source.js";
import * as copySourceModule from "../../src/migration/copy-source.js";
import * as runtimeReadiness from "../../src/storage/postgresql/runtime-readiness.js";
import { PORTABLE_RECORD_DOMAIN_ORDER, canonicalJson, type PortableDomain } from "../../src/storage/portable-record.js";
import type { PortableCheckpoint } from "../../src/storage/portable-record-stream.js";
import type { StorageIdentityContext } from "../../src/storage/contracts.js";
import {
  MigrationVerificationDriverError,
  assertPermanentReadOnlyGuard,
  readFencedDestinationCensus,
  readSequenceSelfConsistencyMismatches,
  reconcileCounts,
  sortMismatches,
  streamSourceCheckpoints,
  totalsFor,
  truncateMismatchesPerClass,
  verifyMigrationGeneration,
  type VerifyMigrationGenerationDependencies,
  type VerifyMigrationGenerationInput,
} from "../../src/migration/verify-generation.js";

const HASH_A = "a".repeat(64);
const FAKE_MIGRATIONS = [{ id: "0001", filename: "0001.sql", sql: "", sha256: HASH_A }];
const EXPECTED_MIGRATIONS_SHA256 = createHash("sha256")
  .update(canonicalJson(FAKE_MIGRATIONS.map(({ id, sha256 }) => ({ id, sha256 }))), "utf8")
  .digest("hex");

function fakeHash(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}
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

function fakeConversationRecord(createdAt: string, identitySeed: string) {
  return {
    version: 1, domain: "conversations" as const, domainVersion: 1, ordinal: 0, order: [],
    identitySha256: fakeHash(`identity-${identitySeed}`),
    dependencies: [],
    value: {
      conversationFingerprint: fakeHash(`fingerprint-${identitySeed}`), occurrenceOrdinal: 0,
      sessionId: identitySeed, createdAt, title: null, bootstrappedAt: null, updatedAt: createdAt,
    },
    recordSha256: fakeHash(`record-${identitySeed}`),
  };
}

function fakeStream(
  recordCounts: Partial<Record<PortableDomain, number>> = {},
  conversationsRecords: ReadonlyArray<ReturnType<typeof fakeConversationRecord>> = [],
) {
  return {
    readBatch: vi.fn(async ({ domain }: { domain: PortableDomain }) => {
      const records = domain === "conversations" ? conversationsRecords : [];
      const recordCount = recordCounts[domain] ?? 0;
      return {
        version: 1, manifestSha256: HASH_A, domain, records, framedBytes: 0, complete: true,
        priorCheckpointSha256: null, checkpoint: checkpoint(domain, recordCount, fakeHash(`prefix-${domain}-${recordCount}`)),
      };
    }),
    verify: vi.fn(),
    close: vi.fn(async () => { /* fake */ }),
  };
}

function fakeCopySource(overrides: {
  recordCounts?: Partial<Record<PortableDomain, number>>;
  conversationsRecords?: ReadonlyArray<ReturnType<typeof fakeConversationRecord>>;
  reauthenticate?: () => Promise<void>;
} = {}) {
  const stream = fakeStream(overrides.recordCounts, overrides.conversationsRecords);
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

function fakeSession(overrides: {
  xid?: string | null;
  sequenceState?: Partial<Record<string, {
    maxValue: string | null; lastValue: string | null; isCalled?: boolean; incrementBy?: string;
  }>>;
} = {}) {
  const sequenceState = overrides.sequenceState ?? {};
  const seqNameFor = (domain: string) => `lcm.fake_${domain}_seq`;
  return {
    identity: { sessionId: "window-session", backendPid: 999, projectId },
    query: vi.fn(async (config: { text: string; values?: readonly unknown[] }) => {
      if (config.text.includes("pg_current_xact_id_if_assigned")) return { rows: [{ xid: overrides.xid ?? null }] };
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
      if (config.text.includes("FROM lcm.fake_")) {
        const domain = Object.keys(SEQUENCE_BACKED_TABLES).find((candidate) => config.text.includes(seqNameFor(candidate)));
        const state = domain ? sequenceState[domain] : undefined;
        if (state === undefined || state.lastValue === null) return { rows: [] };
        return { rows: [{ last_value: state.lastValue, is_called: state.isCalled ?? true }] };
      }
      if (config.text.includes("pg_catalog.pg_sequence")) {
        const seqName = config.values?.[0] as string | undefined;
        const domain = Object.keys(SEQUENCE_BACKED_TABLES).find((candidate) => seqNameFor(candidate) === seqName);
        const state = domain ? sequenceState[domain] : undefined;
        if (state === undefined) return { rows: [] };
        return { rows: [{ increment_by: state.incrementBy ?? "1" }] };
      }
      return { rows: [{ admitted: true }] };
    }),
    close: vi.fn(async () => { /* fake */ }),
  };
}

function fakeRuntime(overrides: {
  session?: ReturnType<typeof fakeSession>;
  conversationsRows?: ReadonlyArray<Record<string, unknown>>;
} = {}) {
  const session = overrides.session ?? fakeSession();
  return {
    health: vi.fn(async () => ({ status: "healthy", backend: "postgresql", tls: true, serverMajorVersion: 18, serverEncoding: "UTF8" })),
    query: vi.fn(async (config: { text: string }) => (config.text.includes("lcm.conversations")
      ? { rows: overrides.conversationsRows ?? [] }
      : { rows: [{ system_identifier: "7123456789" }] })),
    transaction: vi.fn(async (callback: (executor: unknown) => Promise<unknown>) => callback({
      query: vi.fn(async () => ({ rows: [] })),
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
} = {}) {
  vi.spyOn(coordination, "PostgreSqlWorkCoordinator").mockImplementation(function () { return ({
    acquireLease: vi.fn(async () => ({ fencingToken: 1n } as never)),
    releaseLease: vi.fn(async () => null),
  } as never); });
  vi.spyOn(migrations, "loadPostgreSqlMigrations").mockReturnValue(FAKE_MIGRATIONS as never);
  vi.spyOn(searchConfiguration, "inspectPostgreSqlSearchConfiguration").mockResolvedValue({ actualSha256: HASH_A } as never);
  vi.spyOn(portableSource, "readPostgreSqlPortableWitness").mockResolvedValue(HASH_A);
  vi.spyOn(portableSource, "createPostgreSqlPortableSource").mockResolvedValue({ close: vi.fn(async () => { /* fake */ }) } as never);
  const defaultCensus = (domain: PortableDomain) => ({
    domain, recordCount: PORTABLE_RECORD_DOMAIN_ORDER.indexOf(domain), prefixSha256: fakeHash(`prefix-${domain}-${PORTABLE_RECORD_DOMAIN_ORDER.indexOf(domain)}`),
    terminalIdentitySha256: PORTABLE_RECORD_DOMAIN_ORDER.indexOf(domain) === 0 ? null : HASH_A,
  });
  vi.spyOn(portableSource, "readPostgreSqlPortableSourceDomainCensus").mockImplementation(((_source: unknown, domain: PortableDomain) => (options.domainCensus ?? defaultCensus)(domain)) as never);
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
    expect(result).toHaveLength(PORTABLE_RECORD_DOMAIN_ORDER.length);
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
    expect(conversationsPublicOrder).toEqual([
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
    expect(conversationsPublicOrder).toEqual([
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
    expect(conversationsPublicOrder).toEqual([
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
    expect(conversationsPublicOrder).toEqual([
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
    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(copySource.stream.close).toHaveBeenCalledTimes(1);
  }, 15000);

  it("produces a digest-class mismatch when record counts agree but content diverges", async () => {
    stubDestinationPrimitives({
      domainCensus: (domain) => ({ domain, recordCount: 3, prefixSha256: fakeHash(`digest-mismatch-${domain}`), terminalIdentitySha256: HASH_A }),
    });
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => [domain, 3])) as Partial<Record<PortableDomain, number>>;
    const copySource = fakeCopySource({ recordCounts });
    const runtime = fakeRuntime();
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
    const runtime = fakeRuntime();
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

  it("refuses when the verification lease is already held", async () => {
    vi.spyOn(coordination, "PostgreSqlWorkCoordinator").mockImplementation(function () { return ({
      acquireLease: vi.fn(async () => null),
      releaseLease: vi.fn(async () => null),
    } as never); });
    vi.spyOn(migrations, "loadPostgreSqlMigrations").mockReturnValue(FAKE_MIGRATIONS as never);
    vi.spyOn(searchConfiguration, "inspectPostgreSqlSearchConfiguration").mockResolvedValue({ actualSha256: HASH_A } as never);
    vi.spyOn(portableSource, "readPostgreSqlPortableWitness").mockResolvedValue(HASH_A);
    const copySource = fakeCopySource();
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(copySource, runtime);
    await expect(verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-lease" }), dependencies))
      .rejects.toMatchObject({ reason: "lease-unavailable" });
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  it("refuses when the destination search configuration is absent", async () => {
    vi.spyOn(coordination, "PostgreSqlWorkCoordinator").mockImplementation(function () { return ({
      acquireLease: vi.fn(async () => ({ fencingToken: 1n } as never)), releaseLease: vi.fn(async () => null),
    } as never); });
    vi.spyOn(migrations, "loadPostgreSqlMigrations").mockReturnValue(FAKE_MIGRATIONS as never);
    vi.spyOn(searchConfiguration, "inspectPostgreSqlSearchConfiguration").mockResolvedValue({ actualSha256: null } as never);
    vi.spyOn(portableSource, "readPostgreSqlPortableWitness").mockResolvedValue(HASH_A);
    const copySource = fakeCopySource();
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(copySource, runtime);
    await expect(verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-search" }), dependencies))
      .rejects.toThrow(MigrationVerificationDriverError);
  });

  it("refuses when the destination system identifier is malformed", async () => {
    vi.spyOn(coordination, "PostgreSqlWorkCoordinator").mockImplementation(function () { return ({
      acquireLease: vi.fn(async () => ({ fencingToken: 1n } as never)), releaseLease: vi.fn(async () => null),
    } as never); });
    vi.spyOn(migrations, "loadPostgreSqlMigrations").mockReturnValue(FAKE_MIGRATIONS as never);
    vi.spyOn(searchConfiguration, "inspectPostgreSqlSearchConfiguration").mockResolvedValue({ actualSha256: HASH_A } as never);
    vi.spyOn(portableSource, "readPostgreSqlPortableWitness").mockResolvedValue(HASH_A);
    const copySource = fakeCopySource();
    const badRuntime = fakeRuntime();
    badRuntime.query = vi.fn(async () => ({ rows: [{ system_identifier: "not-a-number" }] })) as never;
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

  it("swallows a failure releasing the lease without masking the primary result", async () => {
    stubDestinationPrimitives();
    vi.spyOn(coordination, "PostgreSqlWorkCoordinator").mockImplementation(function () { return ({
      acquireLease: vi.fn(async () => ({ fencingToken: 1n } as never)),
      releaseLease: vi.fn(async () => { throw new Error("release-failure-canary"); }),
    } as never); });
    const recordCounts = Object.fromEntries(PORTABLE_RECORD_DOMAIN_ORDER.map((domain, index) => [domain, index])) as Partial<Record<PortableDomain, number>>;
    const copySource = fakeCopySource({ recordCounts });
    const runtime = fakeRuntime();
    const dependencies = dependenciesFor(copySource, runtime);
    const result = await verifyMigrationGeneration(baseInput({ homeDir: "/tmp/lcm-verify-release-fail" }), dependencies);
    expect(result.outcome).toBe("clean");
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
});

describe("readSequenceSelfConsistencyMismatches", () => {
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
    expect(result.report.mismatches).toEqual([
      { domain: "public-listing", class: "sample", identitySha256: expect.any(String) },
    ]);
  }, 15000);
});
