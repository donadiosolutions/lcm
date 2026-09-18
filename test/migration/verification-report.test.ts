import { describe, expect, it } from "vitest";
import { PORTABLE_RECORD_DOMAIN_ORDER, type PortableDomain } from "../../src/storage/portable-record.js";
import { migrationWitnessSha256 } from "../../src/migration/activation-witness.js";
import {
  MIGRATION_MISMATCH_CLASSES,
  MIGRATION_MISMATCH_CLASS_TRUNCATION_LIMIT,
  MIGRATION_RECONCILIATION_DOMAIN_ORDER,
  MigrationVerificationReportError,
  createMigrationVerificationReport,
  createMigrationVerificationReportBody,
  migrationReconciliationOutcomeDigest,
  parseMigrationQueueClassificationWitness,
  parseMigrationSourceWitnessDigests,
  parseMigrationVerificationReport,
  parseMigrationVerificationSampleParameters,
  type CreateMigrationVerificationReportInput,
  type MigrationQueueClassificationWitness,
  type MigrationSourceWitnessDigests,
  type MigrationVerificationMismatch,
  type MigrationVerificationMismatchTotal,
  type MigrationVerificationSampleParameters,
} from "../../src/migration/verification-report.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function expectReportError(callback: () => unknown, reason: MigrationVerificationReportError["reason"]): void {
  try {
    callback();
    throw new Error("expected MigrationVerificationReportError");
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationVerificationReportError);
    expect((error as MigrationVerificationReportError).reason).toBe(reason);
  }
}

function domainVector<T>(build: (domain: PortableDomain, index: number) => T): T[] {
  return PORTABLE_RECORD_DOMAIN_ORDER.map(build);
}

function sourceWitness(overrides: Partial<MigrationSourceWitnessDigests> = {}): MigrationSourceWitnessDigests {
  return parseMigrationSourceWitnessDigests({
    version: 1, identitySha256: HASH_A, schemaSha256: HASH_B, contentSha256: HASH_C, ...overrides,
  });
}

function queueClassificationWitness(
  overrides: Partial<MigrationQueueClassificationWitness> = {},
): MigrationQueueClassificationWitness {
  return parseMigrationQueueClassificationWitness({
    version: 1, queueCutoff: "0000000000000000001", queueSetSha256: HASH_A,
    receiptSetSha256: HASH_B, epochChecksumSha256: HASH_C, ...overrides,
  });
}

function sampleParameters(overrides: Partial<MigrationVerificationSampleParameters> = {}): MigrationVerificationSampleParameters {
  return parseMigrationVerificationSampleParameters({
    version: 1, strideOrdinal: 97, sampleCount: 32, seedBasisSha256: HASH_D, ...overrides,
  });
}

function baseInput(overrides: Partial<CreateMigrationVerificationReportInput> = {}): CreateMigrationVerificationReportInput {
  return {
    generationId: "generation-1",
    targetGenerationId: "generation-1-postgresql",
    bindingSha256: HASH_A,
    manifestRevision: 4,
    manifestChecksumSha256: HASH_B,
    sourceWitness: sourceWitness(),
    destinationIdentity: { version: 1, sealedWitnessSha256: HASH_C, systemIdentifier: "712345" },
    destinationSchemaWitness: {
      version: 1, migrationsSha256: HASH_A, searchConfigurationSha256: HASH_B,
      collationSha256: HASH_C, sequenceStateSha256: HASH_D,
    },
    projectMapWitnessSha256: HASH_D,
    queueClassificationWitness: queueClassificationWitness(),
    censusVector: {
      version: 1,
      domains: domainVector((domain, index) => ({ domain, recordCount: index, prefixSha256: migrationWitnessSha256(["c", domain]) })),
      contentSha256: HASH_A,
    },
    canonicalDelta: {
      version: 1,
      domains: domainVector((domain, index) => ({ domain, recordCount: index, terminalIdentitySha256: migrationWitnessSha256(["d", domain]) })),
    },
    classCoverage: MIGRATION_MISMATCH_CLASSES.map((mismatchClass) => ({ class: mismatchClass, ran: true })),
    publicProbeSha256: migrationWitnessSha256(["public-probe"]),
    sampleParameters: sampleParameters(),
    mismatches: [],
    mismatchTotals: [],
    ...overrides,
  };
}

describe("frozen mismatch vocabulary", () => {
  it("carries 22 portable domains plus four pseudo-domains", () => {
    expect(MIGRATION_RECONCILIATION_DOMAIN_ORDER.length).toBe(PORTABLE_RECORD_DOMAIN_ORDER.length + 4);
    expect(MIGRATION_RECONCILIATION_DOMAIN_ORDER.slice(-4)).toEqual(["schema", "ledger", "public-listing", "public-search"]);
  });
  it("carries exactly eight closed mismatch classes", () => {
    expect(MIGRATION_MISMATCH_CLASSES).toEqual([
      "count", "digest", "identity", "relation", "sequence", "schema", "ledger", "sample",
    ]);
  });
});

describe("parseMigrationVerificationSampleParameters", () => {
  it("round-trips a valid record", () => {
    expect(sampleParameters().strideOrdinal).toBe(97);
  });
  it("rejects an invalid shape", () => {
    expectReportError(() => parseMigrationVerificationSampleParameters({}), "malformed-record");
  });
  it("rejects an invalid version", () => {
    expectReportError(() => sampleParameters({ version: 2 as 1 }), "invalid-input");
  });
  it("rejects a non-positive stride", () => {
    expectReportError(() => sampleParameters({ strideOrdinal: 0 }), "invalid-input");
  });
  it("rejects a negative sample count", () => {
    expectReportError(() => sampleParameters({ sampleCount: -1 }), "invalid-input");
  });
  it("rejects an invalid seed basis digest", () => {
    expectReportError(() => sampleParameters({ seedBasisSha256: "nope" }), "invalid-input");
  });
});

describe("parseMigrationQueueClassificationWitness", () => {
  it("round-trips a record with a null queue cutoff", () => {
    expect(queueClassificationWitness({ queueCutoff: null }).queueCutoff).toBeNull();
  });
  it("round-trips a record with a 19-digit queue cutoff", () => {
    expect(queueClassificationWitness().queueCutoff).toBe("0000000000000000001");
  });
  it("rejects an invalid shape", () => {
    expectReportError(() => parseMigrationQueueClassificationWitness({}), "malformed-record");
  });
  it("rejects an invalid queue cutoff format", () => {
    expectReportError(() => queueClassificationWitness({ queueCutoff: "12" }), "invalid-input");
  });
  it("rejects an invalid queueSetSha256", () => {
    expectReportError(() => queueClassificationWitness({ queueSetSha256: "nope" }), "invalid-input");
  });
  it("rejects an invalid receiptSetSha256", () => {
    expectReportError(() => queueClassificationWitness({ receiptSetSha256: "nope" }), "invalid-input");
  });
  it("rejects an invalid epochChecksumSha256", () => {
    expectReportError(() => queueClassificationWitness({ epochChecksumSha256: "nope" }), "invalid-input");
  });
});

describe("parseMigrationSourceWitnessDigests", () => {
  it("round-trips a valid record", () => {
    expect(sourceWitness().identitySha256).toBe(HASH_A);
  });
  it("rejects an invalid shape", () => {
    expectReportError(() => parseMigrationSourceWitnessDigests({}), "malformed-record");
  });
  it("rejects invalid digests", () => {
    expectReportError(() => sourceWitness({ identitySha256: "nope" }), "invalid-input");
    expectReportError(() => sourceWitness({ schemaSha256: "nope" }), "invalid-input");
    expectReportError(() => sourceWitness({ contentSha256: "nope" }), "invalid-input");
  });
});

describe("createMigrationVerificationReportBody", () => {
  it("builds a clean body with a stable reconciliation outcome digest", () => {
    const body = createMigrationVerificationReportBody(baseInput());
    expect(body.reconciliationOutcomeDigestSha256).toBe(migrationReconciliationOutcomeDigest([], []));
  });
  it("rejects invalid scalar fields", () => {
    expectReportError(() => createMigrationVerificationReportBody(baseInput({ generationId: "" })), "invalid-input");
    expectReportError(() => createMigrationVerificationReportBody(baseInput({ targetGenerationId: "" })), "invalid-input");
    expectReportError(() => createMigrationVerificationReportBody(baseInput({ bindingSha256: "nope" })), "invalid-input");
    expectReportError(() => createMigrationVerificationReportBody(baseInput({ manifestRevision: -1 })), "invalid-input");
    expectReportError(() => createMigrationVerificationReportBody(baseInput({ manifestChecksumSha256: "nope" })), "invalid-input");
    expectReportError(() => createMigrationVerificationReportBody(baseInput({ projectMapWitnessSha256: "nope" })), "invalid-input");
  });
  it("rejects mismatches that are not an array", () => {
    expectReportError(
      () => createMigrationVerificationReportBody(baseInput({ mismatches: "bad" as unknown as MigrationVerificationMismatch[] })),
      "invalid-input",
    );
  });
  it("rejects mismatchTotals that are not an array", () => {
    expectReportError(
      () => createMigrationVerificationReportBody(baseInput({ mismatchTotals: "bad" as unknown as MigrationVerificationMismatchTotal[] })),
      "invalid-input",
    );
  });
  it("rejects a malformed mismatch entry", () => {
    expectReportError(() => createMigrationVerificationReportBody(baseInput({
      mismatches: [{ domain: "messages", class: "count", identitySha256: "nope" }],
    })), "invalid-input");
    expectReportError(() => createMigrationVerificationReportBody(baseInput({
      mismatches: [{ domain: "not-a-domain", class: "count", identitySha256: HASH_A } as unknown as MigrationVerificationMismatch],
    })), "invalid-input");
    expectReportError(() => createMigrationVerificationReportBody(baseInput({
      mismatches: [{ domain: "messages", class: "not-a-class", identitySha256: HASH_A } as unknown as MigrationVerificationMismatch],
    })), "invalid-input");
  });
  it("rejects a malformed mismatch total entry", () => {
    expectReportError(() => createMigrationVerificationReportBody(baseInput({
      mismatches: [{ domain: "messages", class: "count", identitySha256: HASH_A }],
      mismatchTotals: [{ domain: "messages", class: "count", count: 0 }],
    })), "invalid-input");
  });
  it("accepts a consistent single mismatch with a matching total", () => {
    const body = createMigrationVerificationReportBody(baseInput({
      mismatches: [{ domain: "messages", class: "count", identitySha256: HASH_A }],
      mismatchTotals: [{ domain: "messages", class: "count", count: 1 }],
    }));
    expect(body.reconciliationOutcomeDigestSha256).not.toBe(migrationReconciliationOutcomeDigest([], []));
  });
  it("rejects mismatches out of (domain, class, identity) order", () => {
    expectReportError(() => createMigrationVerificationReportBody(baseInput({
      mismatches: [
        { domain: "messages", class: "count", identitySha256: HASH_B },
        { domain: "conversations", class: "count", identitySha256: HASH_A },
      ],
      mismatchTotals: [
        { domain: "conversations", class: "count", count: 1 },
        { domain: "messages", class: "count", count: 1 },
      ],
    })), "invalid-input");
  });
  it("rejects duplicate mismatch entries", () => {
    expectReportError(() => createMigrationVerificationReportBody(baseInput({
      mismatches: [
        { domain: "messages", class: "count", identitySha256: HASH_A },
        { domain: "messages", class: "count", identitySha256: HASH_A },
      ],
      mismatchTotals: [{ domain: "messages", class: "count", count: 2 }],
    })), "invalid-input");
  });
  it("rejects mismatch totals out of (domain, class) order", () => {
    expectReportError(() => createMigrationVerificationReportBody(baseInput({
      mismatches: [
        { domain: "conversations", class: "count", identitySha256: HASH_A },
        { domain: "messages", class: "count", identitySha256: HASH_A },
      ],
      mismatchTotals: [
        { domain: "messages", class: "count", count: 1 },
        { domain: "conversations", class: "count", count: 1 },
      ],
    })), "invalid-input");
  });
  it("rejects duplicate mismatch totals for the same (domain, class)", () => {
    expectReportError(() => createMigrationVerificationReportBody(baseInput({
      mismatches: [{ domain: "messages", class: "count", identitySha256: HASH_A }],
      mismatchTotals: [
        { domain: "messages", class: "count", count: 1 },
        { domain: "messages", class: "count", count: 1 },
      ],
    })), "invalid-input");
  });
  it("rejects mismatches with the same domain but out-of-order classes", () => {
    expectReportError(() => createMigrationVerificationReportBody(baseInput({
      mismatches: [
        { domain: "messages", class: "identity", identitySha256: HASH_A },
        { domain: "messages", class: "count", identitySha256: HASH_B },
      ],
      mismatchTotals: [
        { domain: "messages", class: "identity", count: 1 },
        { domain: "messages", class: "count", count: 1 },
      ],
    })), "invalid-input");
  });
  it("accepts two ascending-identity mismatches sharing a (domain, class)", () => {
    const lowIdentity = "0".repeat(64);
    const highIdentity = "f".repeat(64);
    const body = createMigrationVerificationReportBody(baseInput({
      mismatches: [
        { domain: "messages", class: "count", identitySha256: lowIdentity },
        { domain: "messages", class: "count", identitySha256: highIdentity },
      ],
      mismatchTotals: [{ domain: "messages", class: "count", count: 2 }],
    }));
    expect(body.reconciliationOutcomeDigestSha256).not.toBe(migrationReconciliationOutcomeDigest([], []));
  });
  it("rejects two descending-identity mismatches sharing a (domain, class)", () => {
    const lowIdentity = "0".repeat(64);
    const highIdentity = "f".repeat(64);
    expectReportError(() => createMigrationVerificationReportBody(baseInput({
      mismatches: [
        { domain: "messages", class: "count", identitySha256: highIdentity },
        { domain: "messages", class: "count", identitySha256: lowIdentity },
      ],
      mismatchTotals: [{ domain: "messages", class: "count", count: 2 }],
    })), "invalid-input");
  });
  it("rejects a recorded mismatch with no matching total", () => {
    expectReportError(() => createMigrationVerificationReportBody(baseInput({
      mismatches: [{ domain: "messages", class: "count", identitySha256: HASH_A }],
      mismatchTotals: [],
    })), "unexpected-state");
  });
  it("rejects a total smaller than its recorded entries", () => {
    expectReportError(() => createMigrationVerificationReportBody(baseInput({
      mismatches: [
        { domain: "messages", class: "count", identitySha256: HASH_A },
        { domain: "messages", class: "count", identitySha256: HASH_B },
      ],
      mismatchTotals: [{ domain: "messages", class: "count", count: 1 }],
    })), "unexpected-state");
  });
  it("rejects a total with no recorded mismatches", () => {
    expectReportError(() => createMigrationVerificationReportBody(baseInput({
      mismatches: [],
      mismatchTotals: [{ domain: "messages", class: "count", count: 1 }],
    })), "unexpected-state");
  });
  it("rejects a class exceeding the frozen per-class truncation limit", () => {
    const mismatches: MigrationVerificationMismatch[] = [];
    for (let index = 0; index <= MIGRATION_MISMATCH_CLASS_TRUNCATION_LIMIT; index += 1) {
      mismatches.push({ domain: "schema", class: "schema", identitySha256: index.toString(16).padStart(64, "0") });
    }
    expectReportError(() => createMigrationVerificationReportBody(baseInput({
      mismatches,
      mismatchTotals: [{ domain: "schema", class: "schema", count: mismatches.length }],
    })), "invalid-input");
  });
});

describe("createMigrationVerificationReport / parseMigrationVerificationReport", () => {
  it("creates a clean report and round-trips it", () => {
    const report = createMigrationVerificationReport(baseInput());
    expect(report.clean).toBe(true);
    expect(report.reportId).toBe(`verify-generation-${report.reportSha256}`);
    expect(parseMigrationVerificationReport(report)).toEqual(report);
  });
  it("creates a dirty report and round-trips it", () => {
    const report = createMigrationVerificationReport(baseInput({
      mismatches: [{ domain: "messages", class: "count", identitySha256: HASH_A }],
      mismatchTotals: [{ domain: "messages", class: "count", count: 1 }],
    }));
    expect(report.clean).toBe(false);
    expect(parseMigrationVerificationReport(report)).toEqual(report);
  });
  it("two reports differ in identity only when their content differs", () => {
    const a = createMigrationVerificationReport(baseInput());
    const b = createMigrationVerificationReport(baseInput());
    const c = createMigrationVerificationReport(baseInput({ manifestRevision: 5 }));
    expect(a.reportSha256).toBe(b.reportSha256);
    expect(a.reportSha256).not.toBe(c.reportSha256);
  });
  it("rejects an invalid shape on parse", () => {
    expectReportError(() => parseMigrationVerificationReport({}), "malformed-record");
  });
  it("rejects invalid scalar fields on parse", () => {
    const report = createMigrationVerificationReport(baseInput());
    expectReportError(() => parseMigrationVerificationReport({ ...report, version: 2 }), "invalid-input");
    expectReportError(() => parseMigrationVerificationReport({ ...report, reportId: "" }), "invalid-input");
    expectReportError(() => parseMigrationVerificationReport({ ...report, reportSha256: "nope" }), "invalid-input");
    expectReportError(() => parseMigrationVerificationReport({ ...report, clean: "yes" }), "invalid-input");
  });
  it("rejects a non-record body", () => {
    const report = createMigrationVerificationReport(baseInput());
    expectReportError(() => parseMigrationVerificationReport({ ...report, body: "bad" }), "malformed-record");
  });
  it("rejects mismatches or mismatchTotals that are not arrays", () => {
    const report = createMigrationVerificationReport(baseInput());
    expectReportError(() => parseMigrationVerificationReport({ ...report, mismatches: "bad" }), "invalid-input");
    expectReportError(() => parseMigrationVerificationReport({ ...report, mismatchTotals: "bad" }), "invalid-input");
  });
  it("rejects a clean flag that disagrees with the mismatch totals", () => {
    const report = createMigrationVerificationReport(baseInput());
    expectReportError(() => parseMigrationVerificationReport({ ...report, clean: false }), "unexpected-state");
  });
  it("rejects a tampered checksum", () => {
    const report = createMigrationVerificationReport(baseInput());
    expectReportError(() => parseMigrationVerificationReport({ ...report, reportSha256: HASH_A }), "unexpected-state");
  });
  it("rejects a report id that does not match its content", () => {
    const report = createMigrationVerificationReport(baseInput());
    expectReportError(() => parseMigrationVerificationReport({ ...report, reportId: `verify-generation-${HASH_A}` }), "unexpected-state");
  });
  it("computes activationEligible as false when clean but a required class did not run", () => {
    const notFullyCovered = createMigrationVerificationReport(baseInput({
      classCoverage: MIGRATION_MISMATCH_CLASSES.map((mismatchClass) => ({ class: mismatchClass, ran: mismatchClass !== "ledger" })),
    }));
    expect(notFullyCovered.clean).toBe(true);
    expect(notFullyCovered.activationEligible).toBe(false);
    expect(parseMigrationVerificationReport(notFullyCovered)).toEqual(notFullyCovered);
  });
  it("computes activationEligible as false when every class ran but the report is dirty", () => {
    const dirtyButCovered = createMigrationVerificationReport(baseInput({
      mismatches: [{ domain: "messages", class: "count", identitySha256: HASH_A }],
      mismatchTotals: [{ domain: "messages", class: "count", count: 1 }],
    }));
    expect(dirtyButCovered.activationEligible).toBe(false);
  });
  it("rejects a tampered activationEligible flag on parse", () => {
    const report = createMigrationVerificationReport(baseInput());
    expectReportError(() => parseMigrationVerificationReport({ ...report, activationEligible: false }), "unexpected-state");
  });
  it("rejects a non-boolean activationEligible on parse", () => {
    const report = createMigrationVerificationReport(baseInput());
    expectReportError(() => parseMigrationVerificationReport({ ...report, activationEligible: "yes" }), "invalid-input");
  });
});

describe("class coverage vector", () => {
  it("rejects a coverage vector with the wrong number of entries", () => {
    expectReportError(() => createMigrationVerificationReport(baseInput({
      classCoverage: MIGRATION_MISMATCH_CLASSES.slice(0, 3).map((mismatchClass) => ({ class: mismatchClass, ran: true })),
    })), "invalid-input");
  });
  it("rejects a coverage vector out of the frozen class order", () => {
    const shuffled = [...MIGRATION_MISMATCH_CLASSES].reverse().map((mismatchClass) => ({ class: mismatchClass, ran: true }));
    expectReportError(() => createMigrationVerificationReport(baseInput({ classCoverage: shuffled })), "invalid-input");
  });
  it("rejects a coverage entry with a non-boolean ran field", () => {
    const invalid = MIGRATION_MISMATCH_CLASSES.map((mismatchClass, index) => ({
      class: mismatchClass, ran: index === 0 ? ("yes" as unknown as boolean) : true,
    }));
    expectReportError(() => createMigrationVerificationReport(baseInput({ classCoverage: invalid })), "invalid-input");
  });
  it("rejects a mismatch total naming a class the coverage vector marks as not run", () => {
    expectReportError(() => createMigrationVerificationReport(baseInput({
      classCoverage: MIGRATION_MISMATCH_CLASSES.map((mismatchClass) => ({ class: mismatchClass, ran: mismatchClass !== "count" })),
      mismatches: [{ domain: "messages", class: "count", identitySha256: HASH_A }],
      mismatchTotals: [{ domain: "messages", class: "count", count: 1 }],
    })), "invalid-input");
  });
});
