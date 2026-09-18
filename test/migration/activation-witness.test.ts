import { describe, expect, it } from "vitest";
import { PORTABLE_RECORD_DOMAIN_ORDER, type PortableDomain } from "../../src/storage/portable-record.js";
import {
  MigrationActivationWitnessError,
  classifyMigrationRollbackMode,
  createMigrationActivationAttempt,
  createMigrationActivationEpoch,
  createMigrationActivationWitness,
  deriveMigrationActivationAttemptId,
  deriveMigrationActivationEpochId,
  migrationActivationCensusMatchVerdict,
  migrationCanonicalDeltaChanged,
  migrationCensusVectorsEqual,
  migrationWitnessSha256,
  parseMigrationActivationAttempt,
  parseMigrationActivationEpoch,
  parseMigrationActivationWitness,
  parseMigrationCanonicalDelta,
  parseMigrationCensusVector,
  parseMigrationDestinationIdentity,
  parseMigrationIntraActivationWatermark,
  parseMigrationQuiescenceFence,
  parseMigrationSchemaWitness,
  parseMigrationSelectionAuthority,
  type MigrationActivationAttempt,
  type MigrationActivationEpoch,
  type MigrationCanonicalDelta,
  type MigrationCensusVector,
  type MigrationDestinationIdentity,
  type MigrationQuiescenceFence,
  type MigrationSchemaWitness,
  type MigrationSelectionAuthority,
} from "../../src/migration/activation-witness.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function expectWitnessError(callback: () => unknown, reason: MigrationActivationWitnessError["reason"]): void {
  try {
    callback();
    throw new Error("expected MigrationActivationWitnessError");
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationActivationWitnessError);
    expect((error as MigrationActivationWitnessError).reason).toBe(reason);
  }
}

function selectionAuthority(overrides: Partial<MigrationSelectionAuthority> = {}): MigrationSelectionAuthority {
  return parseMigrationSelectionAuthority({
    version: 1,
    resourceType: "migration-activation",
    resourceKey: "generation-1",
    fencingToken: "42",
    ownerProcessId: "worker-1",
    ...overrides,
  });
}

function destinationIdentity(overrides: Partial<MigrationDestinationIdentity> = {}): MigrationDestinationIdentity {
  return parseMigrationDestinationIdentity({
    version: 1,
    sealedWitnessSha256: HASH_A,
    systemIdentifier: "7123456789012345678",
    ...overrides,
  });
}

function domainVector<T>(build: (domain: PortableDomain, index: number) => T): T[] {
  return PORTABLE_RECORD_DOMAIN_ORDER.map(build);
}

function canonicalDelta(seed = 0): MigrationCanonicalDelta {
  return parseMigrationCanonicalDelta({
    version: 1,
    domains: domainVector((domain, index) => ({
      domain,
      recordCount: index + seed,
      terminalIdentitySha256: migrationWitnessSha256(["delta", domain, seed]),
    })),
  });
}

function censusVector(seed = 0): MigrationCensusVector {
  return parseMigrationCensusVector({
    version: 1,
    domains: domainVector((domain, index) => ({
      domain,
      recordCount: index + seed,
      prefixSha256: migrationWitnessSha256(["census", domain, seed]),
    })),
    contentSha256: migrationWitnessSha256(["content", seed]),
  });
}

function schemaWitness(overrides: Partial<MigrationSchemaWitness> = {}): MigrationSchemaWitness {
  return parseMigrationSchemaWitness({
    version: 1,
    migrationsSha256: HASH_A,
    searchConfigurationSha256: HASH_B,
    collationSha256: HASH_C,
    sequenceStateSha256: HASH_D,
    ...overrides,
  });
}

function quiescenceFence(overrides: Partial<MigrationQuiescenceFence> = {}): MigrationQuiescenceFence {
  return parseMigrationQuiescenceFence({
    version: 1,
    fenceId: "fence-1",
    replayEvidenceSha256: HASH_A,
    ...overrides,
  });
}

function epoch(seed = 0, generationId = "generation-1"): MigrationActivationEpoch {
  return createMigrationActivationEpoch({
    generationId,
    manifestRevision: 3,
    manifestChecksumSha256: HASH_A,
    verificationReportId: "report-1",
    verificationReportSha256: HASH_B,
    projectMapWitnessSha256: HASH_C,
    queueClassificationWitnessSha256: HASH_D,
    destinationIdentity: destinationIdentity(),
    censusVector: censusVector(seed),
    schemaWitness: schemaWitness(),
  });
}

function attempt(input: {
  readonly epochId: string;
  readonly deltaSeed?: number;
  readonly censusSeed?: number;
  readonly fenceId?: string;
}): MigrationActivationAttempt {
  return createMigrationActivationAttempt({
    epochId: input.epochId,
    selectionAuthority: selectionAuthority(),
    canonicalDeltaBaseline: canonicalDelta(input.deltaSeed ?? 0),
    activationRecomputedCensus: censusVector(input.censusSeed ?? 0),
    intraActivationWatermark: null,
    quiescenceFence: quiescenceFence({ fenceId: input.fenceId ?? "fence-1" }),
  });
}

describe("migrationWitnessSha256", () => {
  it("throws for values that are not canonical JSON", () => {
    expect(() => migrationWitnessSha256(undefined)).toThrow(TypeError);
    expect(() => migrationWitnessSha256(Number.NaN)).toThrow(TypeError);
    expect(() => migrationWitnessSha256({ value: BigInt(1) })).toThrow(TypeError);
    expect(() => migrationWitnessSha256({ value: new Date() })).toThrow(TypeError);
  });

  it("rejects cyclic values and accepts null-prototype objects", () => {
    const cyclicObject: Record<string, unknown> = {};
    cyclicObject.self = cyclicObject;
    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);
    expect(() => migrationWitnessSha256(cyclicObject)).toThrow(TypeError);
    expect(() => migrationWitnessSha256(cyclicArray)).toThrow(TypeError);
    expect(() => migrationWitnessSha256(Object.create(null) as object)).not.toThrow();
  });

  it("normalizes negative zero and is stable under key order", () => {
    expect(migrationWitnessSha256({ value: -0 })).toBe(migrationWitnessSha256({ value: 0 }));
    expect(migrationWitnessSha256({ a: 1, b: 2 })).toBe(migrationWitnessSha256({ b: 2, a: 1 }));
  });
});

describe("MigrationSelectionAuthority", () => {
  it("round-trips a valid record", () => {
    expect(selectionAuthority()).toEqual({
      version: 1, resourceType: "migration-activation", resourceKey: "generation-1",
      fencingToken: "42", ownerProcessId: "worker-1",
    });
  });
  it("rejects an invalid shape", () => {
    expectWitnessError(() => parseMigrationSelectionAuthority({ version: 1 }), "malformed-record");
  });
  it("rejects an invalid version", () => {
    expectWitnessError(() => selectionAuthority({ version: 2 as 1 }), "invalid-input");
  });
  it("rejects an invalid resourceType", () => {
    expectWitnessError(() => selectionAuthority({ resourceType: "" }), "invalid-input");
  });
  it("rejects an invalid resourceKey", () => {
    expectWitnessError(() => selectionAuthority({ resourceKey: "" }), "invalid-input");
  });
  it("rejects a fencing token with a leading zero", () => {
    expectWitnessError(() => selectionAuthority({ fencingToken: "007" }), "invalid-input");
  });
  it("accepts a fencing token of exactly zero", () => {
    expect(selectionAuthority({ fencingToken: "0" }).fencingToken).toBe("0");
  });
  it("rejects an invalid ownerProcessId", () => {
    expectWitnessError(() => selectionAuthority({ ownerProcessId: "" }), "invalid-input");
  });
});

describe("MigrationDestinationIdentity", () => {
  it("round-trips a valid record", () => {
    expect(destinationIdentity().sealedWitnessSha256).toBe(HASH_A);
  });
  it("rejects an invalid shape", () => {
    expectWitnessError(() => parseMigrationDestinationIdentity({}), "malformed-record");
  });
  it("rejects an invalid sealedWitnessSha256", () => {
    expectWitnessError(() => destinationIdentity({ sealedWitnessSha256: "nope" }), "invalid-input");
  });
  it("rejects an invalid systemIdentifier", () => {
    expectWitnessError(() => destinationIdentity({ systemIdentifier: "01" }), "invalid-input");
  });
});

describe("MigrationCanonicalDelta", () => {
  it("round-trips a valid vector and detects change", () => {
    const a = canonicalDelta(0);
    const b = canonicalDelta(0);
    const c = canonicalDelta(1);
    expect(migrationCanonicalDeltaChanged(a, b)).toBe(false);
    expect(migrationCanonicalDeltaChanged(a, c)).toBe(true);
  });
  it("rejects an invalid shape", () => {
    expectWitnessError(() => parseMigrationCanonicalDelta({ version: 1 }), "malformed-record");
  });
  it("rejects an invalid version", () => {
    expectWitnessError(() => parseMigrationCanonicalDelta({ version: 2, domains: [] }), "invalid-input");
  });
  it("rejects a domain vector of the wrong length", () => {
    expectWitnessError(() => parseMigrationCanonicalDelta({ version: 1, domains: [] }), "malformed-record");
  });
  it("rejects a domain vector out of frozen order", () => {
    const raw = domainVector((domain, index) => ({
      domain, recordCount: index, terminalIdentitySha256: HASH_A,
    }));
    const reversed = [...raw].reverse();
    expectWitnessError(() => parseMigrationCanonicalDelta({ version: 1, domains: reversed }), "invalid-input");
  });
  it("rejects an entry with an invalid recordCount", () => {
    const raw = domainVector((domain, index) => ({
      domain, recordCount: index === 0 ? -1 : index, terminalIdentitySha256: HASH_A,
    }));
    expectWitnessError(() => parseMigrationCanonicalDelta({ version: 1, domains: raw }), "invalid-input");
  });
  it("rejects an entry with an invalid terminalIdentitySha256", () => {
    const raw = domainVector((domain, index) => ({
      domain, recordCount: index, terminalIdentitySha256: index === 0 ? "nope" : HASH_A,
    }));
    expectWitnessError(() => parseMigrationCanonicalDelta({ version: 1, domains: raw }), "invalid-input");
  });
});

describe("MigrationCensusVector", () => {
  it("round-trips a valid vector and detects equality", () => {
    const a = censusVector(0);
    const b = censusVector(0);
    const c = censusVector(1);
    expect(migrationCensusVectorsEqual(a, b)).toBe(true);
    expect(migrationCensusVectorsEqual(a, c)).toBe(false);
  });
  it("rejects an invalid shape", () => {
    expectWitnessError(() => parseMigrationCensusVector({ version: 1 }), "malformed-record");
  });
  it("rejects an invalid contentSha256", () => {
    expectWitnessError(() => parseMigrationCensusVector({
      version: 1, domains: domainVector((domain, index) => ({ domain, recordCount: index, prefixSha256: HASH_A })),
      contentSha256: "nope",
    }), "invalid-input");
  });
  it("rejects an entry with an invalid prefixSha256", () => {
    const raw = domainVector((domain, index) => ({
      domain, recordCount: index, prefixSha256: index === 0 ? "nope" : HASH_A,
    }));
    expectWitnessError(() => parseMigrationCensusVector({ version: 1, domains: raw, contentSha256: HASH_A }), "invalid-input");
  });
});

describe("MigrationSchemaWitness", () => {
  it("round-trips a valid record", () => {
    expect(schemaWitness().migrationsSha256).toBe(HASH_A);
  });
  it("rejects an invalid shape", () => {
    expectWitnessError(() => parseMigrationSchemaWitness({}), "malformed-record");
  });
  it("rejects an invalid migrationsSha256", () => {
    expectWitnessError(() => schemaWitness({ migrationsSha256: "nope" }), "invalid-input");
  });
  it("rejects an invalid searchConfigurationSha256", () => {
    expectWitnessError(() => schemaWitness({ searchConfigurationSha256: "nope" }), "invalid-input");
  });
  it("rejects an invalid collationSha256", () => {
    expectWitnessError(() => schemaWitness({ collationSha256: "nope" }), "invalid-input");
  });
  it("rejects an invalid sequenceStateSha256", () => {
    expectWitnessError(() => schemaWitness({ sequenceStateSha256: "nope" }), "invalid-input");
  });
});

describe("MigrationQuiescenceFence and MigrationIntraActivationWatermark", () => {
  it("round-trips a valid quiescence fence", () => {
    expect(quiescenceFence().fenceId).toBe("fence-1");
  });
  it("rejects an invalid quiescence fence shape", () => {
    expectWitnessError(() => parseMigrationQuiescenceFence({}), "malformed-record");
  });
  it("rejects an invalid quiescence fence id", () => {
    expectWitnessError(() => quiescenceFence({ fenceId: "" }), "invalid-input");
  });
  it("rejects an invalid quiescence fence evidence digest", () => {
    expectWitnessError(() => quiescenceFence({ replayEvidenceSha256: "nope" }), "invalid-input");
  });
  it("round-trips a valid intra-activation watermark", () => {
    const watermark = parseMigrationIntraActivationWatermark({ version: 1, scopeId: "scope-1", observedSha256: HASH_A });
    expect(watermark.scopeId).toBe("scope-1");
  });
  it("rejects an invalid watermark shape", () => {
    expectWitnessError(() => parseMigrationIntraActivationWatermark({}), "malformed-record");
  });
  it("rejects an invalid watermark scopeId", () => {
    expectWitnessError(
      () => parseMigrationIntraActivationWatermark({ version: 1, scopeId: "", observedSha256: HASH_A }),
      "invalid-input",
    );
  });
  it("rejects an invalid watermark digest", () => {
    expectWitnessError(
      () => parseMigrationIntraActivationWatermark({ version: 1, scopeId: "scope-1", observedSha256: "nope" }),
      "invalid-input",
    );
  });
});

describe("MigrationActivationEpoch", () => {
  it("derives epochId from exactly five fields", () => {
    const input = {
      generationId: "generation-1", manifestChecksumSha256: HASH_A, verificationReportSha256: HASH_B,
      projectMapWitnessSha256: HASH_C, queueClassificationWitnessSha256: HASH_D,
    };
    expect(deriveMigrationActivationEpochId(input)).toBe(deriveMigrationActivationEpochId(input));
  });
  it("is byte-identical across attempts with different selection authority (not an input)", () => {
    const first = epoch(0);
    const second = epoch(0);
    expect(first.epochId).toBe(second.epochId);
    expect(first).toEqual(second);
  });
  it("does not include the census vector, since it is copied not derived", () => {
    // v3 section 7: epochId is derived from generationId, manifestChecksumSha256,
    // verificationReportSha256, projectMapWitnessSha256 and
    // queueClassificationWitnessSha256 only, so it stays byte-identical even
    // when the (copied, not derived) census vector differs.
    expect(epoch(0).epochId).toBe(epoch(1).epochId);
    expect(epoch(0)).not.toEqual(epoch(1));
  });
  it("changes when generationId changes", () => {
    expect(epoch(0, "generation-1").epochId).not.toBe(epoch(0, "generation-2").epochId);
  });
  it("rejects an invalid input shape", () => {
    expectWitnessError(() => createMigrationActivationEpoch({
      generationId: "", manifestRevision: 0, manifestChecksumSha256: HASH_A, verificationReportId: "r",
      verificationReportSha256: HASH_B, projectMapWitnessSha256: HASH_C, queueClassificationWitnessSha256: HASH_D,
      destinationIdentity: destinationIdentity(), censusVector: censusVector(), schemaWitness: schemaWitness(),
    }), "invalid-input");
  });
  it("rejects an invalid destinationIdentity", () => {
    expect(() => createMigrationActivationEpoch({
      generationId: "generation-1", manifestRevision: 0, manifestChecksumSha256: HASH_A, verificationReportId: "r",
      verificationReportSha256: HASH_B, projectMapWitnessSha256: HASH_C, queueClassificationWitnessSha256: HASH_D,
      destinationIdentity: { bad: true } as unknown as MigrationDestinationIdentity,
      censusVector: censusVector(), schemaWitness: schemaWitness(),
    })).toThrow(MigrationActivationWitnessError);
  });
  it("round-trips through parseMigrationActivationEpoch", () => {
    const value = epoch(0);
    expect(parseMigrationActivationEpoch(value)).toEqual(value);
  });
  it("rejects an invalid shape on parse", () => {
    expectWitnessError(() => parseMigrationActivationEpoch({}), "malformed-record");
  });
  it("rejects a malformed epochId hash on parse", () => {
    expectWitnessError(() => parseMigrationActivationEpoch({ ...epoch(0), epochId: "nope" }), "invalid-input");
  });
  it("rejects an epochId that does not match its derivation", () => {
    expectWitnessError(() => parseMigrationActivationEpoch({ ...epoch(0), epochId: HASH_A }), "unexpected-state");
  });
});

describe("MigrationActivationAttempt", () => {
  it("derives attemptId from every variable field including the full quiescence fence", () => {
    const e = epoch(0);
    const withFenceOne = attempt({ epochId: e.epochId, fenceId: "fence-1" });
    const withFenceTwo = attempt({ epochId: e.epochId, fenceId: "fence-2" });
    // #624 acceptance: two attempts differing only in quiescence fence evidence
    // must produce different identities (v3.1 corrected the v3 P1 that omitted it).
    expect(withFenceOne.attemptId).not.toBe(withFenceTwo.attemptId);
  });
  it("is deterministic for identical inputs", () => {
    const e = epoch(0);
    expect(attempt({ epochId: e.epochId }).attemptId).toBe(attempt({ epochId: e.epochId }).attemptId);
  });
  it("supports a null intra-activation watermark and a present one", () => {
    const e = epoch(0);
    const withoutWatermark = attempt({ epochId: e.epochId });
    expect(withoutWatermark.intraActivationWatermark).toBeNull();
    const withWatermark = createMigrationActivationAttempt({
      epochId: e.epochId, selectionAuthority: selectionAuthority(),
      canonicalDeltaBaseline: canonicalDelta(), activationRecomputedCensus: censusVector(),
      intraActivationWatermark: parseMigrationIntraActivationWatermark({ version: 1, scopeId: "scope-1", observedSha256: HASH_A }),
      quiescenceFence: quiescenceFence(),
    });
    expect(withWatermark.attemptId).not.toBe(withoutWatermark.attemptId);
  });
  it("rejects an invalid epochId", () => {
    expectWitnessError(() => createMigrationActivationAttempt({
      epochId: "nope", selectionAuthority: selectionAuthority(), canonicalDeltaBaseline: canonicalDelta(),
      activationRecomputedCensus: censusVector(), intraActivationWatermark: null, quiescenceFence: quiescenceFence(),
    }), "invalid-input");
  });
  it("round-trips through parseMigrationActivationAttempt", () => {
    const e = epoch(0);
    const value = attempt({ epochId: e.epochId });
    expect(parseMigrationActivationAttempt(value)).toEqual(value);
  });
  it("rejects an invalid shape on parse", () => {
    expectWitnessError(() => parseMigrationActivationAttempt({}), "malformed-record");
  });
  it("rejects a malformed attemptId or epochId on parse", () => {
    const e = epoch(0);
    const value = attempt({ epochId: e.epochId });
    expectWitnessError(() => parseMigrationActivationAttempt({ ...value, attemptId: "nope" }), "invalid-input");
    expectWitnessError(() => parseMigrationActivationAttempt({ ...value, epochId: "nope" }), "invalid-input");
  });
  it("rejects an intraActivationWatermark that is neither null nor a record", () => {
    const e = epoch(0);
    const value = attempt({ epochId: e.epochId });
    expectWitnessError(
      () => parseMigrationActivationAttempt({ ...value, intraActivationWatermark: "bad" }),
      "invalid-input",
    );
  });
  it("rejects an attemptId that does not match its derivation", () => {
    const e = epoch(0);
    const value = attempt({ epochId: e.epochId });
    expectWitnessError(() => parseMigrationActivationAttempt({ ...value, attemptId: HASH_A }), "unexpected-state");
  });
});

describe("migrationActivationCensusMatchVerdict", () => {
  it("recomputes true when the attempt census matches the epoch census", () => {
    const e = epoch(0);
    const a = attempt({ epochId: e.epochId, censusSeed: 0 });
    expect(migrationActivationCensusMatchVerdict(e, a)).toBe(true);
  });
  it("recomputes false when the attempt census diverges from the epoch census", () => {
    const e = epoch(0);
    const a = attempt({ epochId: e.epochId, censusSeed: 1 });
    expect(migrationActivationCensusMatchVerdict(e, a)).toBe(false);
  });
  it("refuses an attempt that does not belong to the epoch", () => {
    const e = epoch(0);
    const other = epoch(0, "generation-2");
    const a = attempt({ epochId: other.epochId });
    expectWitnessError(() => migrationActivationCensusMatchVerdict(e, a), "unexpected-state");
  });
});

describe("classifyMigrationRollbackMode", () => {
  it("returns post-write on a changed canonical delta without needing a census", () => {
    const e = epoch(0);
    const a = attempt({ epochId: e.epochId, deltaSeed: 0 });
    expect(classifyMigrationRollbackMode({
      attempt: a, postEpochDelta: canonicalDelta(1), postEpochCensus: null,
    })).toBe("post-write");
  });
  it("refuses to answer when the delta is equal and no census is supplied", () => {
    const e = epoch(0);
    const a = attempt({ epochId: e.epochId, deltaSeed: 0 });
    expectWitnessError(
      () => classifyMigrationRollbackMode({ attempt: a, postEpochDelta: canonicalDelta(0), postEpochCensus: null }),
      "unexpected-state",
    );
  });
  it("returns pre-write only when the delta is equal and the census matches", () => {
    const e = epoch(0);
    const a = attempt({ epochId: e.epochId, deltaSeed: 0, censusSeed: 0 });
    expect(classifyMigrationRollbackMode({
      attempt: a, postEpochDelta: canonicalDelta(0), postEpochCensus: censusVector(0),
    })).toBe("pre-write");
  });
  it("returns post-write when the delta is equal but the census diverges", () => {
    const e = epoch(0);
    const a = attempt({ epochId: e.epochId, deltaSeed: 0, censusSeed: 0 });
    expect(classifyMigrationRollbackMode({
      attempt: a, postEpochDelta: canonicalDelta(0), postEpochCensus: censusVector(9),
    })).toBe("post-write");
  });
});

describe("MigrationActivationWitness", () => {
  it("creates and round-trips an activation witness", () => {
    const e = epoch(0);
    const a = attempt({ epochId: e.epochId, censusSeed: 0 });
    const witness = createMigrationActivationWitness({
      kind: "activation", epoch: e, attempt: a, postEpochDelta: null, postEpochCensus: null, rollbackMode: null,
    });
    expect(witness.censusMatchVerdict).toBe(true);
    expect(parseMigrationActivationWitness(witness)).toEqual(witness);
  });
  it("rejects an activation witness carrying rollback-only evidence", () => {
    const e = epoch(0);
    const a = attempt({ epochId: e.epochId });
    expectWitnessError(() => createMigrationActivationWitness({
      kind: "activation", epoch: e, attempt: a,
      postEpochDelta: canonicalDelta(1), postEpochCensus: null, rollbackMode: null,
    }), "invalid-input");
  });
  it("creates and round-trips a rollback witness", () => {
    const e = epoch(0);
    const a = attempt({ epochId: e.epochId, deltaSeed: 0, censusSeed: 0 });
    const witness = createMigrationActivationWitness({
      kind: "rollback", epoch: e, attempt: a,
      postEpochDelta: canonicalDelta(0), postEpochCensus: censusVector(0), rollbackMode: "pre-write",
    });
    expect(witness.rollbackMode).toBe("pre-write");
    expect(parseMigrationActivationWitness(witness)).toEqual(witness);
  });
  it("rejects an invalid kind", () => {
    const e = epoch(0);
    const a = attempt({ epochId: e.epochId });
    expectWitnessError(() => createMigrationActivationWitness({
      kind: "bogus" as "activation", epoch: e, attempt: a, postEpochDelta: null, postEpochCensus: null, rollbackMode: null,
    }), "invalid-input");
  });
  it("rejects a witness whose attempt does not match its epoch", () => {
    const e = epoch(0);
    const other = epoch(0, "generation-2");
    const a = attempt({ epochId: other.epochId });
    expectWitnessError(() => createMigrationActivationWitness({
      kind: "activation", epoch: e, attempt: a, postEpochDelta: null, postEpochCensus: null, rollbackMode: null,
    }), "unexpected-state");
  });
  it("rejects a rollback witness missing required evidence", () => {
    const e = epoch(0);
    const a = attempt({ epochId: e.epochId });
    expectWitnessError(() => createMigrationActivationWitness({
      kind: "rollback", epoch: e, attempt: a, postEpochDelta: null, postEpochCensus: null, rollbackMode: "pre-write",
    }), "invalid-input");
    expectWitnessError(() => createMigrationActivationWitness({
      kind: "rollback", epoch: e, attempt: a, postEpochDelta: canonicalDelta(0), postEpochCensus: null, rollbackMode: null,
    }), "invalid-input");
  });
  it("rejects a rollback witness whose stated mode disagrees with the classifier", () => {
    const e = epoch(0);
    const a = attempt({ epochId: e.epochId, deltaSeed: 0, censusSeed: 0 });
    expectWitnessError(() => createMigrationActivationWitness({
      kind: "rollback", epoch: e, attempt: a,
      postEpochDelta: canonicalDelta(0), postEpochCensus: censusVector(0), rollbackMode: "post-write",
    }), "unexpected-state");
  });
  it("rejects an invalid shape on parse", () => {
    expectWitnessError(() => parseMigrationActivationWitness({}), "malformed-record");
  });
  it("rejects invalid scalar fields on parse", () => {
    const e = epoch(0);
    const a = attempt({ epochId: e.epochId });
    const witness = createMigrationActivationWitness({
      kind: "activation", epoch: e, attempt: a, postEpochDelta: null, postEpochCensus: null, rollbackMode: null,
    });
    expectWitnessError(() => parseMigrationActivationWitness({ ...witness, kind: "bogus" }), "invalid-input");
    expectWitnessError(() => parseMigrationActivationWitness({ ...witness, epochId: "nope" }), "invalid-input");
    expectWitnessError(() => parseMigrationActivationWitness({ ...witness, attemptId: "nope" }), "invalid-input");
    expectWitnessError(() => parseMigrationActivationWitness({ ...witness, censusMatchVerdict: "yes" }), "invalid-input");
    expectWitnessError(() => parseMigrationActivationWitness({ ...witness, checksumSha256: "nope" }), "invalid-input");
    expectWitnessError(() => parseMigrationActivationWitness({ ...witness, rollbackMode: "bogus" }), "invalid-input");
  });
  it("rejects a checksum that does not match the recomputed content", () => {
    const e = epoch(0);
    const a = attempt({ epochId: e.epochId });
    const witness = createMigrationActivationWitness({
      kind: "activation", epoch: e, attempt: a, postEpochDelta: null, postEpochCensus: null, rollbackMode: null,
    });
    expectWitnessError(
      () => parseMigrationActivationWitness({ ...witness, checksumSha256: HASH_A }),
      "unexpected-state",
    );
  });
  it("parses postEpochDelta and postEpochCensus payloads on a rollback witness", () => {
    const e = epoch(0);
    const a = attempt({ epochId: e.epochId, deltaSeed: 0, censusSeed: 0 });
    const witness = createMigrationActivationWitness({
      kind: "rollback", epoch: e, attempt: a,
      postEpochDelta: canonicalDelta(0), postEpochCensus: censusVector(0), rollbackMode: "pre-write",
    });
    const parsed = parseMigrationActivationWitness(witness);
    expect(parsed.postEpochDelta).toEqual(canonicalDelta(0));
    expect(parsed.postEpochCensus).toEqual(censusVector(0));
  });
});
