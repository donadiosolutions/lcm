import { describe, expect, it } from "vitest";
import {
  PORTABLE_LIMITS,
  PORTABLE_RECORD_DOMAIN_ORDER,
  PortableStreamError,
  canonicalJson,
  comparePortableOrder,
  createPortableRecord,
  createPortableRecordStream,
  parsePortableRecord,
  serializePortableRecord,
} from "../../src/storage/portable-record-stream.js";
import type {
  PortableCheckpoint,
  PortableDomain,
  PortableRecord,
  PortableRecordInput,
  PortableSourcePage,
  PortableStreamErrorCode,
} from "../../src/storage/portable-record-stream.js";
import {
  CAPTURED_AT_POSTGRES,
  CAPTURED_AT_SQLITE,
  CONVERSATIONS,
  DEFAULT_PASSIVE_STATES,
  EXTERNAL_PROJECT_ID,
  FIXTURE_IDS,
  LOCAL_PROJECT_IDENTITY,
  MACHINE_A,
  MESSAGES,
  MAX_INT4,
  MAX_INT64,
  MAX_SAFE,
  NATIVE_DOMAINS,
  POSTGRES_DIALECT,
  SESSION_A,
  SHARED_PROJECT_IDENTITY,
  SQLITE_DIALECT,
  T,
  assignConversationOrdinals,
  buildDomainDrafts,
  buildRecords,
  buildSourceDescription,
  createFixtureSource,
  createGeneration,
  independentSha256,
  nativeMetadataBytes,
  nativePayloadBytes,
  normalizeLocalDisposition,
  normalizePostgresDisposition,
  postgresGeneration,
  sqliteBoundGeneration,
  sqliteLegacyGeneration,
  sqliteUnboundGeneration,
} from "../fixtures/portable-records.js";
import type { AdapterOptions, UnknownRecord } from "../fixtures/portable-records.js";

function expectCode(run: () => unknown, code: PortableStreamErrorCode): PortableStreamError {
  try {
    run();
  } catch (error) {
    if (!(error instanceof PortableStreamError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error("expected " + code + " but the call succeeded");
}

async function expectAsyncCode(
  run: () => Promise<unknown>,
  code: PortableStreamErrorCode,
): Promise<PortableStreamError> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof PortableStreamError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error("expected " + code + " but the call succeeded");
}

function recordsOf(
  inventory: ReadonlyMap<PortableDomain, readonly PortableRecord[]>,
  domain: PortableDomain,
): readonly PortableRecord[] {
  return inventory.get(domain) as readonly PortableRecord[];
}

function totalRecords(inventory: ReadonlyMap<PortableDomain, readonly PortableRecord[]>): number {
  return [...inventory.values()].reduce((sum, records) => sum + records.length, 0);
}

const SQLITE_BOUND = buildRecords(sqliteBoundGeneration());
const POSTGRES = buildRecords(postgresGeneration());
const SQLITE_UNBOUND = buildRecords(sqliteUnboundGeneration());
const SQLITE_LEGACY = buildRecords(sqliteLegacyGeneration());
describe("case (b): remote-bound SQLite and PostgreSQL produce one identical protocol", () => {
  it("covers all 22 domains with a representative logical project", () => {
    expect([...SQLITE_BOUND.keys()]).toEqual([...PORTABLE_RECORD_DOMAIN_ORDER]);
    expect([...POSTGRES.keys()]).toEqual([...PORTABLE_RECORD_DOMAIN_ORDER]);
    for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
      expect(recordsOf(SQLITE_BOUND, domain).length).toBeGreaterThan(0);
    }
    expect(totalRecords(SQLITE_BOUND)).toBe(totalRecords(POSTGRES));
  });

  it("produces byte-identical canonical records, identities, and dependencies", () => {
    for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
      const sqlite = recordsOf(SQLITE_BOUND, domain);
      const postgres = recordsOf(POSTGRES, domain);
      expect(postgres).toHaveLength(sqlite.length);
      for (let index = 0; index < sqlite.length; index += 1) {
        const left = sqlite[index];
        const right = postgres[index];
        expect(Buffer.from(serializePortableRecord(right))).toEqual(
          Buffer.from(serializePortableRecord(left)),
        );
        expect(right.identitySha256).toBe(left.identitySha256);
        expect(right.recordSha256).toBe(left.recordSha256);
        expect(canonicalJson(right.dependencies)).toBe(canonicalJson(left.dependencies));
        expect(canonicalJson(right.order)).toBe(canonicalJson(left.order));
        expect(right.ordinal).toBe(index);
      }
    }
  });

  it("round-trips every record through the public codec unchanged", () => {
    for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
      for (const record of recordsOf(SQLITE_BOUND, domain)) {
        const bytes = serializePortableRecord(record);
        const parsed = parsePortableRecord(bytes);
        expect(parsed).toEqual(record);
        expect(Buffer.from(serializePortableRecord(parsed))).toEqual(Buffer.from(bytes));
      }
    }
  });

  it("agrees on the whole manifest, batch boundary, and checkpoint chain", async () => {
    const sqlite = createGeneration(sqliteBoundGeneration());
    const postgres = createGeneration(postgresGeneration());
    const sqliteStream = await createPortableRecordStream(sqlite.source);
    const postgresStream = await createPortableRecordStream(postgres.source);
    const left = sqliteStream.describe();
    const right = postgresStream.describe();

    // The isolated protocol case intentionally shares one deterministic source
    // witness, so whole-manifest byte equality is meaningful here.
    expect(canonicalJson(right)).toBe(canonicalJson(left));
    expect(right.manifestSha256).toBe(left.manifestSha256);
    expect(right.contentSha256).toBe(left.contentSha256);
    expect(right.domains.map((entry) => entry.recordCount)).toEqual(
      left.domains.map((entry) => entry.recordCount),
    );
    expect(right.domains.map((entry) => entry.prefixSha256)).toEqual(
      left.domains.map((entry) => entry.prefixSha256),
    );

    for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
      const leftBatch = await sqliteStream.readBatch({
        domain,
        maxRecords: PORTABLE_LIMITS.maxBatchRecords,
        maxBytes: PORTABLE_LIMITS.maxBatchBytes,
      });
      const rightBatch = await postgresStream.readBatch({
        domain,
        maxRecords: PORTABLE_LIMITS.maxBatchRecords,
        maxBytes: PORTABLE_LIMITS.maxBatchBytes,
      });
      expect(canonicalJson(rightBatch)).toBe(canonicalJson(leftBatch));
      expect(rightBatch.checkpoint.checkpointSha256).toBe(leftBatch.checkpoint.checkpointSha256);
      expect(rightBatch.framedBytes).toBe(leftBatch.framedBytes);
      expect(leftBatch.complete).toBe(true);
      expect(leftBatch.checkpoint.previousCheckpointSha256).toBeNull();

      const leftVerification = await sqliteStream.verify(leftBatch.checkpoint);
      const rightVerification = await postgresStream.verify(rightBatch.checkpoint);
      expect(canonicalJson(rightVerification)).toBe(canonicalJson(leftVerification));
      expect(leftVerification.matchesManifestBoundary).toBe(true);
    }
    await sqliteStream.close();
    await postgresStream.close();
  });

  it("never leaks generated PostgreSQL keys or SQLite rowid and FTS details", () => {
    const forbidden = [
      "rowid",
      "_pk",
      "search_digest",
      "conversation_pk",
      "message_pk",
      "9007199254740993",
      "9007199254741001",
      "018f7767-2a00-7c55-9d10-2f0f6d3a1101",
      "018f7768-3b00-7e66-8a21-3f1f7e4b2201",
      "fts",
    ];
    for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
      for (const record of recordsOf(POSTGRES, domain)) {
        const text = Buffer.from(serializePortableRecord(record)).toString("utf8");
        for (const needle of forbidden) expect(text).not.toContain(needle);
      }
    }
  });
});
describe("cases (a) and (c): unlike generations are distinct, not falsely equal", () => {
  it("case (a): an unbound local SQLite export has local-only golden bytes", async () => {
    const projectRecords = recordsOf(SQLITE_UNBOUND, "project");
    expect(projectRecords).toHaveLength(1);
    expect(projectRecords[0].value).toEqual({ identity: LOCAL_PROJECT_IDENTITY });
    expect(projectRecords[0].identitySha256).toBe(
      independentSha256([
        "lcm-portable-identity-v1",
        "project",
        ["local", LOCAL_PROJECT_IDENTITY.projectId],
      ]),
    );

    // The project identity differs, so every project-dependent domain digest
    // differs, and so does the manifest.
    const boundProject = recordsOf(SQLITE_BOUND, "project")[0];
    expect(projectRecords[0].identitySha256).not.toBe(boundProject.identitySha256);
    for (const domain of ["project-aliases", "conversations", "passive-events"] as const) {
      const local = recordsOf(SQLITE_UNBOUND, domain)[0];
      const shared = recordsOf(SQLITE_BOUND, domain)[0];
      expect(local.dependencies).not.toEqual(shared.dependencies);
      expect(local.recordSha256).not.toBe(shared.recordSha256);
    }

    // Domains with no project dependency normalize identically regardless.
    for (const domain of [
      "messages",
      "message-parts",
      "large-files",
      "summaries",
      "summary-file-links",
      "summary-message-links",
      "summary-parent-links",
      "context-items",
      "promoted-memory-tags",
      "native-transcript-message-links",
    ] as const) {
      expect(recordsOf(SQLITE_UNBOUND, domain).map((record) => record.recordSha256)).toEqual(
        recordsOf(SQLITE_BOUND, domain).map((record) => record.recordSha256),
      );
    }

    const unbound = createGeneration(sqliteUnboundGeneration());
    const bound = createGeneration(sqliteBoundGeneration());
    const unboundStream = await createPortableRecordStream(unbound.source);
    const boundStream = await createPortableRecordStream(bound.source);
    expect(unboundStream.describe().contentSha256).not.toBe(boundStream.describe().contentSha256);
    expect(unboundStream.describe().manifestSha256).not.toBe(boundStream.describe().manifestSha256);
    expect(unboundStream.describe().source.sourceWitnessSha256).not.toBe(
      boundStream.describe().source.sourceWitnessSha256,
    );
    await unboundStream.close();
    await boundStream.close();
  });

  it("case (c): a proven legacy generation is authoritative-empty, not merely absent", async () => {
    for (const domain of NATIVE_DOMAINS) {
      expect(recordsOf(SQLITE_LEGACY, domain)).toHaveLength(0);
    }
    const legacy = createGeneration(sqliteLegacyGeneration());
    const bound = createGeneration(sqliteBoundGeneration());
    const legacyStream = await createPortableRecordStream(legacy.source);
    const boundStream = await createPortableRecordStream(bound.source);
    const legacyManifest = legacyStream.describe();

    for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
      const entry = legacyManifest.domains[PORTABLE_RECORD_DOMAIN_ORDER.indexOf(domain)];
      if (NATIVE_DOMAINS.includes(domain)) {
        expect(entry.coverage.state).toBe("authoritative-empty");
        expect(entry.recordCount).toBe(0);
        // Authoritative-empty evidence names the generation proof; it is not a
        // reusable constant, so an unsupported source cannot borrow it.
        expect(entry.coverage.evidenceSha256).toBe(
          independentSha256([
            "lcm-fixture-coverage-authoritative-empty-v1",
            "sqlite-legacy",
            domain,
            "generation-never-stored-this-domain",
          ]),
        );
        expect(entry.coverage.evidenceSha256).not.toBe(
          independentSha256(["lcm-fixture-coverage-available-v1", "sqlite-legacy", domain]),
        );
      } else {
        expect(entry.coverage.state).toBe("available");
      }
    }

    // Different source and manifest evidence is expected and asserted, not
    // papered over.
    expect(legacyManifest.contentSha256).not.toBe(boundStream.describe().contentSha256);
    expect(legacyManifest.manifestSha256).not.toBe(boundStream.describe().manifestSha256);
    expect(legacyManifest.source.sourceIdentitySha256).not.toBe(
      boundStream.describe().source.sourceIdentitySha256,
    );

    // Every unaffected domain still normalizes to the same bytes.
    for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
      if (NATIVE_DOMAINS.includes(domain)) continue;
      expect(recordsOf(SQLITE_LEGACY, domain).map((record) => record.recordSha256)).toEqual(
        recordsOf(SQLITE_BOUND, domain).map((record) => record.recordSha256),
      );
    }

    // An authoritative-empty domain still yields an authenticated terminal page.
    const batch = await legacyStream.readBatch({
      domain: "native-transcripts",
      maxRecords: PORTABLE_LIMITS.maxBatchRecords,
      maxBytes: PORTABLE_LIMITS.maxBatchBytes,
    });
    expect(batch.records).toHaveLength(0);
    expect(batch.complete).toBe(true);
    await legacyStream.close();
    await boundStream.close();
  });

  it("keeps source authentication facts backend-specific outside the shared protocol case", () => {
    const sqlite = buildSourceDescription({
      ...sqliteUnboundGeneration(),
      generation: "sqlite-unbound-local",
    });
    const postgres = buildSourceDescription({
      dialect: POSTGRES_DIALECT,
      projectIdentity: SHARED_PROJECT_IDENTITY,
      generation: "postgres-primary",
    });
    expect(sqlite.capturedAt).toBe(CAPTURED_AT_SQLITE);
    expect(postgres.capturedAt).toBe(CAPTURED_AT_POSTGRES);
    expect(sqlite.capturedAt).not.toBe(postgres.capturedAt);
    expect(sqlite.sourceIdentitySha256).not.toBe(postgres.sourceIdentitySha256);
    expect(sqlite.sourceWitnessSha256).not.toBe(postgres.sourceWitnessSha256);
    for (const description of [sqlite, postgres]) {
      expect(description.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      expect(description.sourceIdentitySha256).toMatch(/^[0-9a-f]{64}$/);
      expect(description.sourceWitnessSha256).toMatch(/^[0-9a-f]{64}$/);
      for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
        expect(description.coverage[domain].evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    // Coverage evidence is per-domain, so one domain's evidence cannot be
    // reused to claim another domain is covered.
    const digests = PORTABLE_RECORD_DOMAIN_ORDER.map(
      (domain) => sqlite.coverage[domain].evidenceSha256,
    );
    expect(new Set(digests).size).toBe(PORTABLE_RECORD_DOMAIN_ORDER.length);
  });
});
describe("passive events preserve acknowledged state without claim ownership", () => {
  const passiveValues = (options: AdapterOptions): readonly UnknownRecord[] =>
    (buildDomainDrafts(options).find((draft) => draft.domain === "passive-events") as {
      values: readonly UnknownRecord[];
    }).values;

  it("freezes the exact semantic envelope in both backends", () => {
    for (const options of [sqliteBoundGeneration(), postgresGeneration()]) {
      for (const value of passiveValues(options)) {
        expect(Object.keys(value).sort()).toEqual([
          "category",
          "createdAt",
          "data",
          "disposition",
          "eventId",
          "eventType",
          "eventVersion",
          "machineIdentityKey",
          "machineSequence",
          "priority",
          "sessionId",
          "sessionSequence",
          "sourceHook",
        ].sort());
        expect(value.sessionId).toBe(SESSION_A);
        expect(value.category).toBe("intent");
        expect(value.sourceHook).toBe("PreCompact");
        expect(value.data).toBe("{\"summary\":\"compacted\"}");
      }
    }
  });

  it("excludes the predecessor pointer and every delivery or claim field", () => {
    const excluded = [
      "previousEventId",
      "prev_event_id",
      "claim_owner",
      "claimed_by",
      "claimed_at",
      "attempt_count",
      "retry_count",
      "last_attempt_at",
      "inbox_id",
      "quarantine_reason",
      "quarantine_detail",
      "processed_at",
      "processedAt",
      "delivery_state",
      "deliveryState",
    ];
    for (const record of recordsOf(SQLITE_BOUND, "passive-events")) {
      const text = Buffer.from(serializePortableRecord(record)).toString("utf8");
      for (const field of excluded) expect(text).not.toContain(field);
    }
    // The predecessor pointer exists in the declared local shape, so its
    // absence from the record is a deliberate projection, not an oversight.
    expect(DEFAULT_PASSIVE_STATES.map((state) => state.eventId)).toEqual([
      FIXTURE_IDS.EVENT_PENDING,
      FIXTURE_IDS.EVENT_APPLIED,
      FIXTURE_IDS.EVENT_QUARANTINED,
    ]);
  });

  it("normalizes all three dispositions from unlike backend vocabularies", () => {
    const sqlite = recordsOf(SQLITE_BOUND, "passive-events");
    const postgres = recordsOf(POSTGRES, "passive-events");
    const dispositions = sqlite.map((record) => (record.value as { disposition: string }).disposition);
    expect(dispositions.sort()).toEqual(["applied", "pending", "quarantined"]);
    for (let index = 0; index < sqlite.length; index += 1) {
      expect((postgres[index].value as { disposition: string }).disposition).toBe(
        (sqlite[index].value as { disposition: string }).disposition,
      );
    }
    // Local precedence.
    expect(normalizeLocalDisposition(null, "pending")).toBe("pending");
    expect(normalizeLocalDisposition(null, "claimed")).toBe("pending");
    expect(normalizeLocalDisposition(null, "retry")).toBe("pending");
    expect(normalizeLocalDisposition(null, "replicated")).toBe("pending");
    expect(normalizeLocalDisposition(null, "acknowledged")).toBe("applied");
    expect(normalizeLocalDisposition(null, "quarantined")).toBe("quarantined");
    // PostgreSQL mapping.
    expect(normalizePostgresDisposition("pending")).toBe("pending");
    expect(normalizePostgresDisposition("claimed")).toBe("pending");
    expect(normalizePostgresDisposition("retry")).toBe("pending");
    expect(normalizePostgresDisposition("applied")).toBe("applied");
    expect(normalizePostgresDisposition("quarantined")).toBe("quarantined");
  });

  it("changes disposition on processed_at only where precedence requires it", () => {
    // Processing promotes pending and retry states to applied.
    for (const state of ["pending", "claimed", "retry", "replicated"]) {
      expect(normalizeLocalDisposition(null, state)).toBe("pending");
      expect(normalizeLocalDisposition(T.event, state)).toBe("applied");
    }
    // Processing also wins over quarantine, preventing replay after promotion.
    expect(normalizeLocalDisposition(null, "quarantined")).toBe("quarantined");
    expect(normalizeLocalDisposition(T.event, "quarantined")).toBe("applied");
    // Acknowledged is already applied, so toggling processed_at changes nothing.
    expect(normalizeLocalDisposition(null, "acknowledged")).toBe("applied");
    expect(normalizeLocalDisposition(T.event, "acknowledged")).toBe("applied");

    // Only the resulting disposition reaches the record digest.
    const unprocessed = buildRecords({
      ...sqliteBoundGeneration(),
      passiveOverride: [
        { eventId: FIXTURE_IDS.EVENT_PENDING, processedAt: null, deliveryState: "acknowledged", postgresState: "applied" },
      ],
    });
    const processed = buildRecords({
      ...sqliteBoundGeneration(),
      passiveOverride: [
        { eventId: FIXTURE_IDS.EVENT_PENDING, processedAt: T.event, deliveryState: "acknowledged", postgresState: "applied" },
      ],
    });
    expect(recordsOf(processed, "passive-events")[0].recordSha256).toBe(
      recordsOf(unprocessed, "passive-events")[0].recordSha256,
    );
  });

  it("changes the digest for every promotion-relevant field", () => {
    const baseline = recordsOf(SQLITE_BOUND, "passive-events")[0];
    const context = { projectIdentity: SHARED_PROJECT_IDENTITY };
    const mutations: readonly UnknownRecord[] = [
      { sessionId: "session-other" },
      { sessionSequence: 9 },
      { category: "mcp" },
      { data: "{\"summary\":\"other\"}" },
      { priority: -1 },
      { sourceHook: "PostToolUse" },
      { createdAt: "2026-08-13T12:19:00.000002Z" },
      { eventType: "session.other" },
      { eventVersion: 2 },
      { machineSequence: 7 },
      { disposition: "applied" },
    ];
    for (const mutation of mutations) {
      const mutated = createPortableRecord({
        domain: "passive-events",
        ordinal: baseline.ordinal,
        value: { ...restoreRaw(baseline.value as unknown as UnknownRecord), ...mutation },
        context,
      } as unknown as PortableRecordInput);
      expect(mutated.recordSha256).not.toBe(baseline.recordSha256);
    }
  });
});

/** Re-express tagged integers as raw scalars the constructor accepts. */
function restoreRaw(value: UnknownRecord): UnknownRecord {
  const raw: UnknownRecord = {};
  for (const [key, item] of Object.entries(value)) {
    raw[key] = typeof item === "object" && item !== null && "$integer" in item
      ? (item as { $integer: string }).$integer
      : item;
  }
  return raw;
}
describe("promoted source-project provenance has one canonical spelling", () => {
  const memoryValue = (options: AdapterOptions): UnknownRecord =>
    (buildDomainDrafts(options).find((draft) => draft.domain === "promoted-memories") as {
      values: readonly UnknownRecord[];
    }).values[0];

  it("collapses SQL NULL, PostgreSQL explicit self, and SQLite stored self to null", () => {
    const postgresNull = memoryValue({ ...postgresGeneration(), sourceProjectSpelling: "sql-null" });
    const postgresSelf = memoryValue({ ...postgresGeneration(), sourceProjectSpelling: "explicit-self" });
    const sqliteSelf = memoryValue({ ...sqliteBoundGeneration(), sourceProjectSpelling: "explicit-self" });
    const sqliteDefault = memoryValue({ ...sqliteBoundGeneration(), sourceProjectSpelling: "sql-null" });
    for (const value of [postgresNull, postgresSelf, sqliteSelf, sqliteDefault]) {
      expect(value.sourceProjectId).toBeNull();
    }
    // All four spellings therefore produce one identical record.
    const digests = [
      { ...postgresGeneration(), sourceProjectSpelling: "sql-null" as const },
      { ...postgresGeneration(), sourceProjectSpelling: "explicit-self" as const },
      { ...sqliteBoundGeneration(), sourceProjectSpelling: "explicit-self" as const },
      { ...sqliteBoundGeneration(), sourceProjectSpelling: "sql-null" as const },
    ].map((options) => recordsOf(buildRecords(options), "promoted-memories")[0].recordSha256);
    expect(new Set(digests).size).toBe(1);
  });

  it("preserves a distinct external source exactly", () => {
    for (const options of [sqliteBoundGeneration(), postgresGeneration()]) {
      const external = memoryValue({ ...options, sourceProjectSpelling: "external" });
      expect(external.sourceProjectId).toBe(EXTERNAL_PROJECT_ID);
    }
    const sqliteExternal = recordsOf(
      buildRecords({ ...sqliteBoundGeneration(), sourceProjectSpelling: "external" }),
      "promoted-memories",
    )[0];
    const postgresExternal = recordsOf(
      buildRecords({ ...postgresGeneration(), sourceProjectSpelling: "external" }),
      "promoted-memories",
    )[0];
    expect(postgresExternal.recordSha256).toBe(sqliteExternal.recordSha256);
    expect(sqliteExternal.recordSha256).not.toBe(
      recordsOf(SQLITE_BOUND, "promoted-memories")[0].recordSha256,
    );
    expect((sqliteExternal.value as { sourceProjectId: string }).sourceProjectId).toBe(
      EXTERNAL_PROJECT_ID,
    );
  });
});

describe("logical records survive physical divergence", () => {
  it("keeps conversation, message, and recall identities free of physical IDs", () => {
    for (const domain of ["conversations", "messages", "recall-surfacings"] as const) {
      const sqlite = recordsOf(SQLITE_BOUND, domain);
      const postgres = recordsOf(POSTGRES, domain);
      for (let index = 0; index < sqlite.length; index += 1) {
        expect(postgres[index].identitySha256).toBe(sqlite[index].identitySha256);
      }
    }
    // The two backends genuinely disagree about physical identifiers.
    const text = JSON.stringify([...SQLITE_BOUND.values()].flat());
    expect(text).not.toContain("9007199254740993");
    expect(text).not.toContain("018f7767-2a00-7c55-9d10-2f0f6d3a1101");
  });

  it("gives identical closures contiguous ordinals and the same ordering on both backends", () => {
    const closureMessages = (handle: string): readonly unknown[] =>
      MESSAGES.filter((message) => message.conversation === handle).map((message) => [
        message.seq,
        message.role,
        message.content,
        message.tokenCount,
        message.createdAt,
      ]);
    const alpha = CONVERSATIONS.find((conversation) => conversation.handle === "alpha");
    const twin = CONVERSATIONS.find((conversation) => conversation.handle === "alpha-twin");
    expect(alpha).toBeDefined();
    expect(twin).toBeDefined();
    expect({
      sessionId: twin?.sessionId,
      title: twin?.title,
      bootstrappedAt: twin?.bootstrappedAt,
      createdAt: twin?.createdAt,
      updatedAt: twin?.updatedAt,
    }).toEqual({
      sessionId: alpha?.sessionId,
      title: alpha?.title,
      bootstrappedAt: alpha?.bootstrappedAt,
      createdAt: alpha?.createdAt,
      updatedAt: alpha?.updatedAt,
    });
    expect(closureMessages("alpha-twin")).toEqual(closureMessages("alpha"));
    expect(closureMessages("alpha-divergent")).not.toEqual(closureMessages("alpha"));

    const assigned = assignConversationOrdinals(CONVERSATIONS, MESSAGES);
    const identicalBlock = [
      assigned.get("alpha") as number,
      assigned.get("alpha-twin") as number,
    ].sort((left, right) => left - right);
    expect(identicalBlock[1] - identicalBlock[0]).toBe(1);
    expect([
      assigned.get("alpha"),
      assigned.get("alpha-twin"),
      assigned.get("alpha-divergent"),
    ].sort()).toEqual([0, 1, 2]);

    const conversations = recordsOf(SQLITE_BOUND, "conversations");
    const values = conversations.map((record) => record.value as {
      sessionId: string;
      title: string | null;
      occurrenceOrdinal: { $integer: string };
    });
    const alphaGroup = values.filter(
      (value) => value.sessionId === SESSION_A && value.title === "Alpha conversation",
    );
    // Identical closures preserve exact multiplicity through a contiguous block.
    expect(alphaGroup.map((value) => value.occurrenceOrdinal.$integer).sort()).toEqual(["0", "1", "2"]);
    const variant = values.find((value) => value.title === "Alpha conversation (variant)");
    // A distinct closure starts its own block rather than extending the first.
    expect(variant?.occurrenceOrdinal.$integer).toBe("0");
    expect(recordsOf(POSTGRES, "conversations").map((record) => record.identitySha256)).toEqual(
      conversations.map((record) => record.identitySha256),
    );
  });

  it("rejects a forced closure-hash collision by full canonical comparison", () => {
    const constantDigest = (): string => "collision";
    expect(() =>
      buildRecords({
        ...sqliteBoundGeneration(),
        // A colliding digest must not be trusted alone.
        closureDigest: constantDigest,
      } as AdapterOptions),
    ).toThrow(/closure digest collision rejected by full canonical comparison/);
  });

  it("retains occurrence ordinals for repeated identical recall tuples and nullable sessions", () => {
    const recalls = recordsOf(SQLITE_BOUND, "recall-surfacings").map(
      (record) => record.value as {
        sessionId: string | null;
        occurrenceOrdinal: { $integer: string };
      },
    );
    const withSession = recalls.filter((value) => value.sessionId === SESSION_A);
    expect(withSession.map((value) => value.occurrenceOrdinal.$integer)).toEqual(["0", "1"]);
    const nullSession = recalls.filter((value) => value.sessionId === null);
    expect(nullSession).toHaveLength(1);
    expect(nullSession[0].occurrenceOrdinal.$integer).toBe("0");
  });

  it("preserves transcript ordering, DAG edges, array order and duplicates, and alias paths", () => {
    const links = recordsOf(SQLITE_BOUND, "native-transcript-message-links").map(
      (record) => record.value as { sourceOrdinal: { $integer: string } },
    );
    expect(links.map((value) => value.sourceOrdinal.$integer)).toEqual(["0", "1"]);

    const parents = recordsOf(SQLITE_BOUND, "summary-parent-links").map(
      (record) => record.value as {
        summaryId: string;
        ordinal: { $integer: string };
        parentSummaryId: string;
      },
    );
    expect(parents).toEqual([
      { summaryId: FIXTURE_IDS.SUMMARY_LEAF, ordinal: { $integer: "0" }, parentSummaryId: FIXTURE_IDS.SUMMARY_ROOT },
      { summaryId: FIXTURE_IDS.SUMMARY_LEAF_TWO, ordinal: { $integer: "0" }, parentSummaryId: FIXTURE_IDS.SUMMARY_ROOT },
    ]);

    const fileLinks = recordsOf(SQLITE_BOUND, "summary-file-links").map(
      (record) => record.value as { ordinal: { $integer: string }; fileId: string },
    );
    // Duplicate file IDs survive at distinct ordinals, in order.
    expect(fileLinks.map((value) => [value.ordinal.$integer, value.fileId])).toEqual([
      ["0", FIXTURE_IDS.FILE_ID],
      ["1", FIXTURE_IDS.ORPHAN_FILE_ID],
      ["2", FIXTURE_IDS.FILE_ID],
    ]);

    const tags = recordsOf(SQLITE_BOUND, "promoted-memory-tags").map(
      (record) => record.value as { ordinal: { $integer: string }; tag: string },
    );
    expect(tags.map((value) => [value.ordinal.$integer, value.tag])).toEqual([
      ["0", "storage"],
      ["1", "protocol"],
      ["2", "storage"],
    ]);

    const aliases = recordsOf(SQLITE_BOUND, "project-aliases").map(
      (record) => record.value as { path: string; normalizedPath: string },
    );
    expect(aliases).toContainEqual({
      machineIdentityKey: MACHINE_A,
      path: "/srv/Repos/Project",
      normalizedPath: "/srv/repos/project",
    });
    for (const alias of aliases) expect(alias.path).not.toBe("");
  });

  it("keeps both context target types and every message-part branch", () => {
    const contextItems = recordsOf(SQLITE_BOUND, "context-items").map(
      (record) => record.value as { itemType: string; messageIdentitySha256: string | null; summaryId: string | null },
    );
    expect(contextItems.map((value) => value.itemType).sort()).toEqual(["message", "summary"]);
    for (const item of contextItems) {
      expect(item.itemType === "message" ? item.summaryId : item.messageIdentitySha256).toBeNull();
    }
    const parts = recordsOf(SQLITE_BOUND, "message-parts").map(
      (record) => record.value as Record<string, unknown>,
    );
    const populated = parts.find((value) => value.partType === "tool") as Record<string, unknown>;
    const nulled = parts.find((value) => value.partType === "text") as Record<string, unknown>;
    const nullable = [
      "textContent", "toolCallId", "toolName", "toolStatus", "toolInput", "toolOutput",
      "toolError", "toolTitle", "patchHash", "patchFiles", "fileMime", "fileName",
      "fileUrl", "subtaskPrompt", "subtaskDescription", "subtaskAgent", "stepReason",
      "stepCost", "stepTokensIn", "stepTokensOut", "snapshotHash", "metadata",
    ];
    for (const field of nullable) {
      expect(nulled[field]).toBeNull();
      expect(populated[field]).not.toBeNull();
    }
    expect(populated.isIgnored).toBe(false);
    expect(populated.isSynthetic).toBe(true);
    expect(populated.compactionAuto).toBe(true);
    expect(nulled.isIgnored).toBe(true);
    expect(nulled.isSynthetic).toBe(false);
    expect(nulled.compactionAuto).toBeNull();
  });

  it("keeps orphan-legal references and machine-scoped instruction rows", () => {
    const fileLinks = recordsOf(SQLITE_BOUND, "summary-file-links").map(
      (record) => (record.value as { fileId: string }).fileId,
    );
    const files = recordsOf(SQLITE_BOUND, "large-files").map(
      (record) => (record.value as { fileId: string }).fileId,
    );
    expect(fileLinks).toContain(FIXTURE_IDS.ORPHAN_FILE_ID);
    expect(files).not.toContain(FIXTURE_IDS.ORPHAN_FILE_ID);
    expect(
      (recordsOf(SQLITE_BOUND, "promoted-memories")[0].value as { sourceSummaryId: string | null })
        .sourceSummaryId ?? (recordsOf(SQLITE_BOUND, "promoted-memories")[1].value as { sourceSummaryId: string | null }).sourceSummaryId,
    ).toBe(FIXTURE_IDS.ORPHAN_SUMMARY_ID);

    const instructions = recordsOf(SQLITE_BOUND, "session-instructions").map(
      (record) => record.value as { machineIdentityKey: string; scopeHash: string },
    );
    expect(new Set(instructions.map((value) => value.machineIdentityKey)).size).toBe(2);
    expect(new Set(instructions.map((value) => value.scopeHash)).size).toBe(1);

    const counters = recordsOf(SQLITE_BOUND, "redaction-counters").map(
      (record) => (record.value as { category: string }).category,
    );
    expect(counters.sort()).toEqual(["built_in", "gitleaks", "global", "project"]);

    const payloads = recordsOf(SQLITE_BOUND, "native-transcripts").map(
      (record) => (record.value as { nativePayload: unknown }).nativePayload,
    );
    expect(payloads.some((payload) => Array.isArray(payload))).toBe(true);
    expect(payloads.some((payload) => !Array.isArray(payload))).toBe(true);
    expect(recordsOf(SQLITE_BOUND, "native-transcript-checkpoints")).toHaveLength(1);
  });
});
describe("branded integer extrema are rejected before a writer sees them", () => {
  function build(domain: PortableDomain, overrides: UnknownRecord): PortableRecord {
    const draft = buildDomainDrafts(sqliteBoundGeneration()).find(
      (item) => item.domain === domain,
    ) as { values: readonly UnknownRecord[]; contexts: readonly unknown[] };
    const value = { ...draft.values[0], ...overrides };
    // Native transcripts carry adapter byte witnesses, so an altered metadata
    // field must be re-witnessed exactly as a real adapter would.
    const context = domain === "native-transcripts"
      ? {
          projectIdentity: SHARED_PROJECT_IDENTITY,
          canonicalPayloadBytes: nativePayloadBytes(
            value.nativePayload as Parameters<typeof nativePayloadBytes>[0],
          ),
          canonicalMetadataBytes: nativeMetadataBytes(value, SQLITE_DIALECT),
        }
      : draft.contexts[0];
    return createPortableRecord({
      domain,
      ordinal: 0,
      value,
      context,
    } as unknown as PortableRecordInput);
  }

  const cases: readonly (readonly [PortableDomain, string, string, string, string])[] = [
    // domain, field, accepted minimum, accepted maximum, one step outside
    ["messages", "seq", "0", MAX_INT64.toString(), "-1"],
    ["messages", "tokenCount", "0", MAX_INT64.toString(), (MAX_INT64 + 1n).toString()],
    ["summaries", "depth", "0", String(MAX_INT4), String(MAX_INT4 + 1)],
    ["summary-file-links", "ordinal", "0", String(MAX_INT4), "-1"],
    ["redaction-counters", "count", "0", MAX_INT64.toString(), (MAX_INT64 + 1n).toString()],
    // The transcript source ordinal is int64 while the link ordinal is int4.
    ["native-transcripts", "sourceOrdinal", "0", MAX_INT64.toString(), (MAX_INT64 + 1n).toString()],
    ["native-transcript-message-links", "sourceOrdinal", "0", String(MAX_INT4), String(MAX_INT4 + 1)],
    ["native-transcript-checkpoints", "revision", "0", String(MAX_SAFE), String(MAX_SAFE + 1)],
    ["passive-events", "eventVersion", "1", String(MAX_INT4), "0"],
    ["passive-events", "machineSequence", "0", MAX_INT64.toString(), "-1"],
    ["passive-events", "sessionSequence", "0", String(MAX_SAFE), String(MAX_SAFE + 1)],
    ["recall-surfacings", "occurrenceOrdinal", "0", String(MAX_SAFE), "-1"],
  ];

  it("accepts each branded minimum and maximum exactly", () => {
    for (const [domain, field, minimum, maximum] of cases) {
      for (const accepted of [minimum, maximum]) {
        const record = build(domain, { [field]: accepted });
        const scalar = (record.value as unknown as Record<string, { $integer: string }>)[field];
        expect(scalar.$integer).toBe(accepted);
      }
    }
  });

  it("rejects one step outside every branded range as unrepresentable", () => {
    for (const [domain, field, , , outside] of cases) {
      expectCode(() => build(domain, { [field]: outside }), "record-unrepresentable");
    }
  });

  it("keeps the signed priority range distinct from nonnegative ranges", () => {
    expect(
      (build("passive-events", { priority: String(-MAX_SAFE) }).value as {
        priority: { $integer: string };
      }).priority.$integer,
    ).toBe(String(-MAX_SAFE));
    expect(
      (build("passive-events", { priority: String(MAX_SAFE) }).value as {
        priority: { $integer: string };
      }).priority.$integer,
    ).toBe(String(MAX_SAFE));
    expectCode(
      () => build("passive-events", { priority: String(-MAX_SAFE - 1) }),
      "record-unrepresentable",
    );
    expectCode(() => build("messages", { seq: String(-1) }), "record-unrepresentable");
  });

  it("accepts equivalent extrema from either backend's declared scalar shape", () => {
    // SQLite yields bigint for values beyond the safe range; PostgreSQL yields
    // the same value as a driver string.
    const fromSqlite = build("messages", { tokenCount: MAX_INT64 });
    const fromPostgres = build("messages", { tokenCount: MAX_INT64.toString() });
    expect(fromPostgres.recordSha256).toBe(fromSqlite.recordSha256);
    expect((fromSqlite.value as { tokenCount: { $integer: string } }).tokenCount.$integer).toBe(
      MAX_INT64.toString(),
    );
  });
});
describe("the 128 MiB record bound covers the maximum accepted native transcript", () => {
  const MAX_PAYLOAD_BYTES = 100 * 1024 * 1024;
  const MAX_METADATA_BYTES = PORTABLE_LIMITS.maxControlBytes;

  /**
   * Canonical numeric spelling expands a raw numeric token by at most 4x.
   * The bound is independently exercised rather than assumed.
   */
  function numericExpansion(raw: string): number {
    const canonical = JSON.stringify(JSON.parse(raw) as number);
    return canonical.length / raw.length;
  }

  it("bounds canonical numeric expansion by 4x across a mantissa and exponent sweep", () => {
    const vectors: string[] = ["0", "-0.0", "1", "1e15", "1E15", "1e-7", "-1e-7", "1.5e300"];
    for (let exponent = -20; exponent <= 20; exponent += 1) {
      vectors.push("1e" + String(exponent));
      vectors.push("-1e" + String(exponent));
      vectors.push("1.2345678901234e" + String(exponent));
    }
    for (let mantissa = 1; mantissa <= 9; mantissa += 1) {
      vectors.push(String(mantissa) + "e15");
      vectors.push("0." + String(mantissa));
    }
    let worst = 0;
    let worstToken = "";
    let accepted = 0;
    for (const raw of vectors) {
      const value = JSON.parse(raw) as number;
      // The bound is a claim about accepted canonical spellings only. A value
      // the codec refuses, such as an integer beyond the safe range, never
      // reaches a record and so cannot expand its bytes.
      let canonical: string;
      try {
        canonical = canonicalJson(value);
      } catch (error) {
        expect(error).toBeInstanceOf(PortableStreamError);
        continue;
      }
      accepted += 1;
      const ratio = canonical.length / raw.length;
      if (ratio > worst) {
        worst = ratio;
        worstToken = raw;
      }
      expect(ratio).toBeLessThanOrEqual(4);
    }
    expect(accepted).toBeGreaterThan(20);
    // The 1e15 family is the documented worst case.
    expect(numericExpansion("1e15")).toBeGreaterThan(3);
    expect(numericExpansion("1e15")).toBeLessThanOrEqual(4);
    expect(worst).toBeLessThanOrEqual(4);
    expect(worstToken).not.toBe("");
  });

  it("bounds a nonempty decoded-string scrub range by 10x with one-character vectors", () => {
    // A scrub replaces a decoded range with a fixed marker; the worst case is a
    // single decoded character replaced by the longest marker.
    const marker = "[redacted]";
    const encodedMarkerBytes = Buffer.byteLength(JSON.stringify(marker), "utf8") - 2;
    for (const character of ["a", "\u00e9", "\u4e2d", "\u{1f600}", "\"", "\\", "\n", "\u0007"]) {
      const encodedRangeBytes = Buffer.byteLength(JSON.stringify(character), "utf8") - 2;
      expect(encodedRangeBytes).toBeGreaterThan(0);
      expect(encodedMarkerBytes / encodedRangeBytes).toBeLessThanOrEqual(10);
    }
    const oversizedMarkerBytes = Buffer.byteLength(JSON.stringify("[redacted!]"), "utf8") - 2;
    const oneByteRange = Buffer.byteLength(JSON.stringify("a"), "utf8") - 2;
    expect(oversizedMarkerBytes / oneByteRange).toBeGreaterThan(10);
  });

  it("keeps number and string token regions disjoint and key reordering size-neutral", () => {
    const document = { b: 1e15, a: "text", c: [1, "two", 3] };
    const reordered = { c: [1, "two", 3], a: "text", b: 1e15 };
    const canonical = canonicalJson(document);
    expect(canonicalJson(reordered)).toBe(canonical);
    expect(Buffer.byteLength(canonicalJson(reordered), "utf8")).toBe(
      Buffer.byteLength(canonical, "utf8"),
    );
    // Numeric tokens never appear inside string tokens: string content is
    // always delimited by quotes the canonicalizer emits.
    const stringRegions = canonical.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
    const withoutStrings = canonical.replace(/"(?:[^"\\]|\\.)*"/g, "");
    for (const region of stringRegions) expect(region.startsWith("\"")).toBe(true);
    expect(withoutStrings).not.toContain("text");
    expect(withoutStrings).toContain("1000000000000000");
  });

  it("survives adversarial escapes and key ordering without canonical growth", () => {
    // A NUL key is refused outright, so hostile input cannot reach the sizing
    // path at all.
    expectCode(() => canonicalJson({ "\u0000zero": "a" }), "malformed-record");
    const hostile = {
      "\\": "b",
      "\"": "c",
      "\u{10000}": "d",
      "\ue000": "e",
    };
    const first = canonicalJson(hostile);
    const shuffled = {
      "\ue000": "e",
      "\u{10000}": "d",
      "\"": "c",
      "\\": "b",
    };
    expect(canonicalJson(shuffled)).toBe(first);
    expect(Buffer.byteLength(canonicalJson(shuffled), "utf8")).toBe(
      Buffer.byteLength(first, "utf8"),
    );
  });

  it("computes the exact envelope overhead and keeps the maximum transcript inside 128 MiB", () => {
    const draft = buildDomainDrafts(sqliteBoundGeneration()).find(
      (item) => item.domain === "native-transcripts",
    ) as { values: readonly UnknownRecord[]; contexts: readonly unknown[] };
    const baseValue = draft.values[0];
    const payload = { d: "" };
    const record = createPortableRecord({
      domain: "native-transcripts",
      ordinal: 0,
      value: { ...baseValue, nativePayload: payload },
      context: {
        projectIdentity: SHARED_PROJECT_IDENTITY,
        canonicalPayloadBytes: nativePayloadBytes(payload),
        canonicalMetadataBytes: nativeMetadataBytes({ ...baseValue, nativePayload: payload }, SQLITE_DIALECT),
      },
    } as unknown as PortableRecordInput);

    const framed = serializePortableRecord(record).byteLength;
    const payloadBytes = nativePayloadBytes(payload);
    const metadataBytes = nativeMetadataBytes({ ...baseValue, nativePayload: payload }, SQLITE_DIALECT);
    // Order, dependency, envelope, digest, and newline bytes are everything the
    // frame carries beyond the two witnessed regions.
    const overhead = framed - payloadBytes - metadataBytes;
    expect(overhead).toBeGreaterThan(0);
    expect(framed).toBe(payloadBytes + metadataBytes + overhead);
    // The last byte is the frame's single trailing newline.
    expect(serializePortableRecord(record).at(-1)).toBe(0x0a);

    // The adapter ceilings plus this overhead remain inside the global bound,
    // with a large margin that does not depend on the fixture's own size.
    const worstCase = MAX_PAYLOAD_BYTES + MAX_METADATA_BYTES + overhead;
    expect(MAX_PAYLOAD_BYTES).toBe(100 * 1024 * 1024);
    expect(MAX_METADATA_BYTES).toBe(1024 * 1024);
    expect(worstCase).toBeLessThan(PORTABLE_LIMITS.maxRecordBytes);
    expect(PORTABLE_LIMITS.maxRecordBytes).toBe(128 * 1024 * 1024);
  });

  it("rejects a payload or metadata region above its adapter ceiling", () => {
    const draft = buildDomainDrafts(sqliteBoundGeneration()).find(
      (item) => item.domain === "native-transcripts",
    ) as { values: readonly UnknownRecord[]; contexts: readonly unknown[] };
    const baseValue = draft.values[0];

    // All metadata maxima at once: an oversized locator alone exceeds 1 MiB.
    const oversizedMetadata: UnknownRecord = {
      ...baseValue,
      sourceLocator: "x".repeat(MAX_METADATA_BYTES),
    };
    expectCode(
      () =>
        createPortableRecord({
          domain: "native-transcripts",
          ordinal: 0,
          value: oversizedMetadata,
          context: {
            projectIdentity: SHARED_PROJECT_IDENTITY,
            canonicalPayloadBytes: nativePayloadBytes(
              oversizedMetadata.nativePayload as Parameters<typeof nativePayloadBytes>[0],
            ),
            canonicalMetadataBytes: nativeMetadataBytes(oversizedMetadata, SQLITE_DIALECT),
          },
        } as unknown as PortableRecordInput),
      "record-unrepresentable",
    );
  });

  it("treats an adapter that omits either byte witness as source-invalid", async () => {
    const draft = buildDomainDrafts(sqliteBoundGeneration()).find(
      (item) => item.domain === "native-transcripts",
    ) as { values: readonly UnknownRecord[]; contexts: readonly unknown[] };
    const value = draft.values[0];
    const generation = sqliteBoundGeneration();
    const records = buildRecords(generation);
    const description = buildSourceDescription(generation);
    const full = {
      projectIdentity: SHARED_PROJECT_IDENTITY,
      canonicalPayloadBytes: nativePayloadBytes(
        value.nativePayload as Parameters<typeof nativePayloadBytes>[0],
      ),
      canonicalMetadataBytes: nativeMetadataBytes(value, SQLITE_DIALECT),
    };
    for (const omitted of ["canonicalPayloadBytes", "canonicalMetadataBytes"] as const) {
      const partial: UnknownRecord = { ...full };
      delete partial[omitted];
      // The codec rejects the incomplete construction context outright, so an
      // adapter cannot present an unwitnessed transcript as valid source data.
      expectCode(
        () =>
          createPortableRecord({
            domain: "native-transcripts",
            ordinal: 0,
            value,
            context: partial,
          } as unknown as PortableRecordInput),
        "malformed-record",
      );

      // At the source boundary, the same adapter defect is a terminal source
      // verdict rather than a caller-owned malformed-record condition.
      const source = createFixtureSource({
        description,
        records,
        readOverride: (input): PortableSourcePage | undefined => {
          if (input.domain !== "native-transcripts") return undefined;
          const record = createPortableRecord({
            domain: "native-transcripts",
            ordinal: 0,
            value,
            context: partial,
          } as unknown as PortableRecordInput);
          return { predecessor: null, records: [record], complete: true };
        },
      });
      const error = await expectAsyncCode(() => createPortableRecordStream(source), "source-invalid");
      expect(error.retryable).toBe(false);
      expect(source.closed()).toBe(true);
    }
    // A witness that disagrees with the canonical bytes is equally rejected.
    expectCode(
      () =>
        createPortableRecord({
          domain: "native-transcripts",
          ordinal: 0,
          value,
          context: { ...full, canonicalPayloadBytes: full.canonicalPayloadBytes + 1 },
        } as unknown as PortableRecordInput),
      "malformed-record",
    );
  });
});
describe("record size failures separate terminal rejection from retryable limits", () => {
  it("accepts a scaled near-limit transcript and rejects 128 MiB + 1 terminally", () => {
    const draft = buildDomainDrafts(sqliteBoundGeneration()).find(
      (item) => item.domain === "native-transcripts",
    ) as { values: readonly UnknownRecord[]; contexts: readonly unknown[] };
    const baseValue = draft.values[0];

    const makeRecord = (payloadChars: number): PortableRecord => {
      const payload = { d: "x".repeat(payloadChars) };
      const value = { ...baseValue, nativePayload: payload };
      return createPortableRecord({
        domain: "native-transcripts",
        ordinal: 0,
        value,
        context: {
          projectIdentity: SHARED_PROJECT_IDENTITY,
          canonicalPayloadBytes: nativePayloadBytes(payload),
          canonicalMetadataBytes: nativeMetadataBytes(value, SQLITE_DIALECT),
        },
      } as unknown as PortableRecordInput);
    };

    // A scaled near-limit vector: just inside the 100 MiB payload ceiling.
    const empty = makeRecord(0);
    const emptyFramed = serializePortableRecord(empty).byteLength;
    const payloadOverhead = nativePayloadBytes({ d: "" });
    const nearLimitChars = 100 * 1024 * 1024 - payloadOverhead;
    const nearLimit = makeRecord(nearLimitChars);
    expect(nativePayloadBytes(
      (nearLimit.value as { nativePayload: Parameters<typeof nativePayloadBytes>[0] }).nativePayload,
    )).toBe(100 * 1024 * 1024);
    expect(serializePortableRecord(nearLimit).byteLength).toBeLessThan(
      PORTABLE_LIMITS.maxRecordBytes,
    );
    expect(emptyFramed).toBeLessThan(serializePortableRecord(nearLimit).byteLength);

    // One byte beyond the payload ceiling is a terminal, non-retryable refusal.
    const beyond = expectCode(() => makeRecord(nearLimitChars + 1), "record-unrepresentable");
    expect(beyond.retryable).toBe(false);
    expect(beyond.domain).toBe("native-transcripts");
  }, 300_000);

  it("rejects a message one byte past the global bound and accepts the exact bound", () => {
    const draft = buildDomainDrafts(sqliteBoundGeneration()).find(
      (item) => item.domain === "messages",
    ) as { values: readonly UnknownRecord[]; contexts: readonly unknown[] };
    const base = draft.values[0];
    const makeMessage = (content: string): PortableRecord =>
      createPortableRecord({
        domain: "messages",
        ordinal: 0,
        value: { ...base, content },
        context: draft.contexts[0],
      } as unknown as PortableRecordInput);

    const overhead = serializePortableRecord(makeMessage("")).byteLength;
    const exactContent = PORTABLE_LIMITS.maxRecordBytes - overhead;
    const exact = makeMessage("x".repeat(exactContent));
    expect(serializePortableRecord(exact).byteLength).toBe(PORTABLE_LIMITS.maxRecordBytes);
    const over = expectCode(() => makeMessage("x".repeat(exactContent + 1)), "record-unrepresentable");
    expect(over.retryable).toBe(false);
  }, 300_000);

  it("fails retryably, without source ambiguity or checkpoint advance, below a caller byte limit", async () => {
    const generation = createGeneration(sqliteBoundGeneration());
    const stream = await createPortableRecordStream(generation.source);
    const first = recordsOf(SQLITE_BOUND, "messages")[0];
    const firstBytes = serializePortableRecord(first).byteLength;

    // The record is globally valid but larger than this caller's byte limit.
    const error = await expectAsyncCode(
      () =>
        stream.readBatch({
          domain: "messages",
          maxRecords: PORTABLE_LIMITS.maxBatchRecords,
          maxBytes: firstBytes - 1,
        }),
      "batch-limit-exceeded",
    );
    expect(error.retryable).toBe(true);
    expect(error.domain).toBe("messages");
    // The failure is a caller-limit condition, not a source verdict.
    expect(error.message).not.toContain("source");

    // No checkpoint advanced: a retry at an adequate limit still starts at zero.
    const retried = await stream.readBatch({
      domain: "messages",
      maxRecords: PORTABLE_LIMITS.maxBatchRecords,
      maxBytes: PORTABLE_LIMITS.maxBatchBytes,
    });
    expect(retried.priorCheckpointSha256).toBeNull();
    expect(retried.checkpoint.nextOrdinal).toBe(recordsOf(SQLITE_BOUND, "messages").length);
    await stream.close();
  });
});
describe("malformed and resumable failures are sanitized and never advance a checkpoint", () => {
  it("rejects an unknown domain and an unsupported version", () => {
    const record = recordsOf(SQLITE_BOUND, "messages")[0];
    const bytes = Buffer.from(serializePortableRecord(record)).toString("utf8");
    expectCode(
      () => parsePortableRecord(Buffer.from(bytes.replace("\"messages\"", "\"not-a-domain\""), "utf8")),
      "unknown-domain",
    );
    expectCode(
      () => parsePortableRecord(Buffer.from(bytes.replace("\"version\":1", "\"version\":2"), "utf8")),
      "unsupported-version",
    );
    expectCode(
      () => parsePortableRecord(Buffer.from(bytes.replace("\"domainVersion\":1", "\"domainVersion\":2"), "utf8")),
      "unsupported-version",
    );
  });

  it("rejects a malformed record and an omission caught by the terminal digest", async () => {
    expectCode(() => parsePortableRecord(Buffer.from("{\"version\":1}\n", "utf8")), "malformed-record");

    // Drop the last record of a domain after the manifest was built: the
    // terminal prefix digest no longer agrees.
    const generation = sqliteBoundGeneration();
    const full = buildRecords(generation);
    const description = buildSourceDescription(generation);
    let omit = false;
    const source = createFixtureSource({
      description,
      records: full,
      readOverride: (input): PortableSourcePage | undefined => {
        if (!omit || input.domain !== "messages") return undefined;
        const all = recordsOf(full, "messages");
        return { predecessor: null, records: all.slice(0, all.length - 1), complete: true };
      },
    });
    const stream = await createPortableRecordStream(source);
    omit = true;
    await expectAsyncCode(
      () =>
        stream.readBatch({
          domain: "messages",
          maxRecords: PORTABLE_LIMITS.maxBatchRecords,
          maxBytes: PORTABLE_LIMITS.maxBatchBytes,
        }),
      "partial-batch",
    );
    await stream.close();
  });

  it("catches duplicate and regressed identities across a predecessor page boundary", async () => {
    for (const domain of ["summary-parent-links", "passive-events"] as const) {
      const generation = { ...sqliteBoundGeneration(), pageSize: 1 };
      const full = buildRecords(generation);
      const all = recordsOf(full, domain);
      expect(all.length).toBeGreaterThanOrEqual(2);
      const draft = buildDomainDrafts(generation).find((item) => item.domain === domain) as {
        values: readonly UnknownRecord[];
        contexts: readonly unknown[];
      };
      const rebuildFirstAt = (ordinal: number): PortableRecord =>
        createPortableRecord({
          domain,
          ordinal,
          value: draft.values[0],
          context: draft.contexts[0],
        } as unknown as PortableRecordInput);

      // Duplicate: page two repeats page one's record, so only the predecessor
      // adjacency check can catch it.
      const duplicateAtOrdinalOne = rebuildFirstAt(1);
      expect(duplicateAtOrdinalOne.identitySha256).toBe(all[0].identitySha256);
      expect(duplicateAtOrdinalOne.ordinal).toBe(1);
      expect(duplicateAtOrdinalOne.domain).toBe(domain);
      expect(duplicateAtOrdinalOne.domainVersion).toBe(1);
      expect(duplicateAtOrdinalOne.dependencies).toEqual(all[0].dependencies);
      expect(parsePortableRecord(serializePortableRecord(duplicateAtOrdinalOne))).toEqual(
        duplicateAtOrdinalOne,
      );
      expect(serializePortableRecord(duplicateAtOrdinalOne).byteLength).toBeLessThanOrEqual(
        PORTABLE_LIMITS.maxBatchBytes,
      );
      expect(comparePortableOrder(all[0].order, duplicateAtOrdinalOne.order)).toBe(0);
      // Mutation control: every earlier page/record gate is satisfied above.
      // Removing the predecessor adjacency predicate would make construction
      // resolve, so the source-invalid expectation below would fail.
      const duplicate = createFixtureSource({
        description: buildSourceDescription(generation),
        records: full,
        pageSize: 1,
        readOverride: (input): PortableSourcePage | undefined => {
          if (input.domain !== domain || input.afterOrdinal !== 1) return undefined;
          return { predecessor: all[0], records: [duplicateAtOrdinalOne], complete: true };
        },
      });
      await expectAsyncCode(() => createPortableRecordStream(duplicate), "source-invalid");

      // Regression: two valid records advance the ordinal before page three
      // presents a strictly earlier order tuple at the expected ordinal.
      const regressedAtOrdinalTwo = rebuildFirstAt(2);
      expect(regressedAtOrdinalTwo.ordinal).toBe(2);
      expect(regressedAtOrdinalTwo.domain).toBe(domain);
      expect(regressedAtOrdinalTwo.domainVersion).toBe(1);
      expect(regressedAtOrdinalTwo.dependencies).toEqual(all[0].dependencies);
      expect(parsePortableRecord(serializePortableRecord(regressedAtOrdinalTwo))).toEqual(
        regressedAtOrdinalTwo,
      );
      expect(serializePortableRecord(regressedAtOrdinalTwo).byteLength).toBeLessThanOrEqual(
        PORTABLE_LIMITS.maxBatchBytes,
      );
      expect(regressedAtOrdinalTwo.identitySha256).not.toBe(all[1].identitySha256);
      expect(comparePortableOrder(all[1].order, regressedAtOrdinalTwo.order)).toBeGreaterThan(0);
      // The identity-equality branch is false and only the strict-order branch
      // rejects. Removing that adjacency predicate makes the expectation fail.
      const regressed = createFixtureSource({
        description: buildSourceDescription(generation),
        records: full,
        pageSize: 1,
        readOverride: (input): PortableSourcePage | undefined => {
          if (input.domain !== domain) return undefined;
          if (input.afterOrdinal === 1) {
            return { predecessor: all[0], records: [all[1]], complete: false };
          }
          if (input.afterOrdinal === 2) {
            return { predecessor: all[1], records: [regressedAtOrdinalTwo], complete: true };
          }
          return undefined;
        },
      });
      await expectAsyncCode(() => createPortableRecordStream(regressed), "source-invalid");
    }
  });

  it("rejects a dangling required dependency and a summary DAG self edge or cycle", () => {
    const draft = buildDomainDrafts(sqliteBoundGeneration()).find(
      (item) => item.domain === "summary-parent-links",
    ) as { values: readonly UnknownRecord[]; contexts: readonly unknown[] };

    // A self edge is refused by value normalization.
    expectCode(
      () =>
        createPortableRecord({
          domain: "summary-parent-links",
          ordinal: 0,
          value: { ...draft.values[0], parentSummaryId: FIXTURE_IDS.SUMMARY_LEAF, summaryId: FIXTURE_IDS.SUMMARY_LEAF },
          context: null,
        } as unknown as PortableRecordInput),
      "malformed-record",
    );

    // Both cycle edges are individually canonical; only the complete adapter
    // inventory can prove that they form a forbidden cycle.
    expect(() =>
      buildRecords({
        ...sqliteBoundGeneration(),
        mutate: (domain, values) => domain === "summary-parent-links"
          ? [
              { summaryId: FIXTURE_IDS.SUMMARY_LEAF, ordinal: 0, parentSummaryId: FIXTURE_IDS.SUMMARY_ROOT },
              { summaryId: FIXTURE_IDS.SUMMARY_ROOT, ordinal: 0, parentSummaryId: FIXTURE_IDS.SUMMARY_LEAF },
            ]
          : values,
      }),
    ).toThrow(/summary DAG cycle/);

    // A syntactically valid link to a nonexistent message is a genuinely
    // dangling required dependency, rather than a parent-order mismatch.
    expect(() =>
      buildRecords({
        ...sqliteBoundGeneration(),
        mutate: (domain, values) => domain === "summary-message-links"
          ? [{ ...values[0], messageIdentitySha256: "0".repeat(64) }, ...values.slice(1)]
          : values,
      }),
    ).toThrow(/dangling required dependency/);
  });

  it("rejects incomplete coverage before any page is trusted", async () => {
    const generation = sqliteBoundGeneration();
    const description = buildSourceDescription(generation);
    const incomplete = { ...description, coverage: { ...description.coverage } } as unknown as {
      coverage: Record<string, unknown>;
    };
    delete incomplete.coverage["passive-events"];
    const source = createFixtureSource({
      description: incomplete as never,
      records: buildRecords(generation),
    });
    await expectAsyncCode(() => createPortableRecordStream(source), "source-invalid");
    expect(source.closed()).toBe(true);
  });

  it("reports source changed, invalid, and unavailable without advancing state", async () => {
    const generation = sqliteBoundGeneration();
    const records = buildRecords(generation);
    const description = buildSourceDescription(generation);

    const changed = createFixtureSource({
      description,
      records,
      verify: (_input, call) => (call === 1 ? "unchanged" : "changed"),
    });
    const changedStream = await createPortableRecordStream(changed);
    const changedError = await expectAsyncCode(
      () =>
        changedStream.readBatch({
          domain: "messages",
          maxRecords: PORTABLE_LIMITS.maxBatchRecords,
          maxBytes: PORTABLE_LIMITS.maxBatchBytes,
        }),
      "source-changed",
    );
    expect(changedError.retryable).toBe(false);
    await changedStream.close();

    const invalid = createFixtureSource({
      description,
      records,
      verify: (_input, call) => (call === 1 ? "unchanged" : "invalid"),
    });
    const invalidStream = await createPortableRecordStream(invalid);
    const invalidError = await expectAsyncCode(
      () =>
        invalidStream.readBatch({
          domain: "messages",
          maxRecords: PORTABLE_LIMITS.maxBatchRecords,
          maxBytes: PORTABLE_LIMITS.maxBatchBytes,
        }),
      "source-invalid",
    );
    expect(invalidError.retryable).toBe(false);
    await invalidStream.close();

    // Unavailable during bounded page construction is retryable.
    const unavailable = createFixtureSource({
      description,
      records,
      verify: (_input, call) => (call === 1 ? "unchanged" : "unavailable"),
    });
    const unavailableStream = await createPortableRecordStream(unavailable);
    const unavailableError = await expectAsyncCode(
      () =>
        unavailableStream.readBatch({
          domain: "messages",
          maxRecords: PORTABLE_LIMITS.maxBatchRecords,
          maxBytes: PORTABLE_LIMITS.maxBatchBytes,
        }),
      "source-unavailable",
    );
    expect(unavailableError.retryable).toBe(true);
    await unavailableStream.close();
  });

  it("keeps every failure sanitized and leaves the caller checkpoint unadvanced", async () => {
    const generation = sqliteBoundGeneration();
    const records = buildRecords(generation);
    const description = buildSourceDescription(generation);
    let fail = false;
    const source = createFixtureSource({
      description,
      records,
      verify: () => (fail ? "unavailable" : "unchanged"),
    });
    const stream = await createPortableRecordStream(source);
    const first = await stream.readBatch({
      domain: "messages",
      maxRecords: 1,
      maxBytes: PORTABLE_LIMITS.maxBatchBytes,
    });
    const checkpoint: PortableCheckpoint = first.checkpoint;
    expect(checkpoint.nextOrdinal).toBe(1);
    expect(checkpoint.complete).toBe(false);

    fail = true;
    const error = await expectAsyncCode(
      () =>
        stream.readBatch({
          domain: "messages",
          after: checkpoint,
          maxRecords: PORTABLE_LIMITS.maxBatchRecords,
          maxBytes: PORTABLE_LIMITS.maxBatchBytes,
        }),
      "source-unavailable",
    );
    // Sanitized evidence: no path, payload, row, or cause text.
    expect(error.message).toBe("Portable record stream error: source-unavailable");
    expect(Object.keys(error)).not.toContain("cause");
    expect(error.retryable).toBe(true);

    // The caller's checkpoint is unchanged and the resumed read still works.
    fail = false;
    const resumed = await stream.readBatch({
      domain: "messages",
      after: checkpoint,
      maxRecords: PORTABLE_LIMITS.maxBatchRecords,
      maxBytes: PORTABLE_LIMITS.maxBatchBytes,
    });
    expect(resumed.priorCheckpointSha256).toBe(checkpoint.checkpointSha256);
    expect(resumed.checkpoint.nextOrdinal).toBe(recordsOf(records, "messages").length);
    expect(resumed.complete).toBe(true);
    await stream.close();
  });
});
