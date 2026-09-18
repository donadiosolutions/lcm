import { describe, expect, it } from "vitest";
import { PORTABLE_RECORD_DOMAIN_ORDER, type PortableDomain } from "../../src/storage/portable-record.js";
import { migrationWitnessSha256 } from "../../src/migration/activation-witness.js";
import {
  MIGRATION_MISMATCH_CLASSES,
  createMigrationVerificationReportBody,
  type CreateMigrationVerificationReportBodyInput,
  type MigrationVerificationReportBody,
} from "../../src/migration/verification-report.js";
import {
  MIGRATION_WITNESS_AUDIT,
  MIGRATION_WITNESS_AUDIT_EXCLUDED_BODY_FIELDS,
  type MigrationWitnessAuditEntry,
} from "../../src/migration/witness-audit.js";

const HASH_A = "a".repeat(64);

function domainVector<T>(build: (domain: PortableDomain, index: number) => T): T[] {
  return PORTABLE_RECORD_DOMAIN_ORDER.map(build);
}

/**
 * The one place this test constructs a real body: everything after this
 * is checked against Object.keys(body), never against a second hand-
 * maintained list of field names, so a field this fixture forgets would
 * make the completeness check pass for the wrong reason. That risk is
 * why every field below is filled from the same type the production
 * driver constructs (CreateMigrationVerificationReportBodyInput), not a
 * looser object literal.
 */
function fixtureBodyInput(): CreateMigrationVerificationReportBodyInput {
  return {
    generationId: "generation-1",
    targetGenerationId: "generation-1-postgresql",
    bindingSha256: HASH_A,
    manifestRevision: 1,
    manifestChecksumSha256: HASH_A,
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
      domains: domainVector((domain, index) => ({ domain, recordCount: index, prefixSha256: migrationWitnessSha256(["c", domain]) })),
      contentSha256: HASH_A,
    },
    canonicalDelta: {
      version: 1,
      domains: domainVector((domain, index) => ({ domain, recordCount: index, terminalIdentitySha256: migrationWitnessSha256(["d", domain]) })),
    },
    classCoverage: MIGRATION_MISMATCH_CLASSES.map((mismatchClass) => ({ class: mismatchClass, ran: true })),
    publicProbeSha256: HASH_A,
    sampleParameters: { version: 1, strideOrdinal: 97, sampleCount: 32, seedBasisSha256: HASH_A },
    mismatches: [],
    mismatchTotals: [],
  };
}

function realBody(): MigrationVerificationReportBody {
  return createMigrationVerificationReportBody(fixtureBodyInput());
}

describe("machine-checked witness audit", () => {
  it("gives every non-excluded report-body field at least one audit entry (the core enforcement)", () => {
    const body = realBody();
    const auditedFields = new Set(MIGRATION_WITNESS_AUDIT.map((entry) => entry.bodyField));
    const uncovered = (Object.keys(body) as (keyof MigrationVerificationReportBody)[])
      .filter((field) => !MIGRATION_WITNESS_AUDIT_EXCLUDED_BODY_FIELDS.has(field))
      .filter((field) => !auditedFields.has(field));
    expect(uncovered).toEqual([]);
  });
  it("has no audit entry naming a field that does not exist on the real body or the excluded set", () => {
    const body = realBody();
    const realFields = new Set(Object.keys(body));
    const stale = MIGRATION_WITNESS_AUDIT.filter((entry) => !realFields.has(entry.bodyField));
    expect(stale).toEqual([]);
  });
  it("never marks an excluded field as also carrying its own audit entry (would be redundant plumbing, not a witness)", () => {
    const overlap = MIGRATION_WITNESS_AUDIT.filter((entry) => MIGRATION_WITNESS_AUDIT_EXCLUDED_BODY_FIELDS.has(entry.bodyField));
    expect(overlap).toEqual([]);
  });
  it("has a unique, non-empty, kebab-case-ish stable id for every entry", () => {
    const ids = MIGRATION_WITNESS_AUDIT.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeGreaterThan(0);
  });
  it("gives every entry a non-empty description and a non-empty onDifference statement", () => {
    for (const entry of MIGRATION_WITNESS_AUDIT) {
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.onDifference.length).toBeGreaterThan(0);
    }
  });
  it("requires a compared-live entry's onDifference to actually describe a consequence, not an n/a placeholder", () => {
    const liveEntries = MIGRATION_WITNESS_AUDIT.filter((entry) => entry.comparison === "compared-live");
    expect(liveEntries.length).toBeGreaterThan(0);
    for (const entry of liveEntries) {
      expect(entry.onDifference.startsWith("n/a")).toBe(false);
    }
  });
  it("requires every non-live entry to state why, rather than leaving the reason implicit", () => {
    const nonLiveEntries = MIGRATION_WITNESS_AUDIT.filter((entry) => entry.comparison !== "compared-live");
    expect(nonLiveEntries.length).toBeGreaterThan(0);
    for (const entry of nonLiveEntries) {
      expect(entry.onDifference.startsWith("n/a")).toBe(true);
    }
  });
  it("fails the completeness check when a real body field is deliberately dropped from the inventory (red-first demonstration)", () => {
    // This is the property the whole module exists to enforce, proven
    // directly rather than only inferred from the passing test above:
    // remove one real, non-excluded entry and show the same completeness
    // logic now reports it as uncovered.
    const withoutSourceWitness: readonly MigrationWitnessAuditEntry[] = MIGRATION_WITNESS_AUDIT.filter(
      (entry) => entry.id !== "source-witness",
    );
    const body = realBody();
    const auditedFields = new Set(withoutSourceWitness.map((entry) => entry.bodyField));
    const uncovered = (Object.keys(body) as (keyof MigrationVerificationReportBody)[])
      .filter((field) => !MIGRATION_WITNESS_AUDIT_EXCLUDED_BODY_FIELDS.has(field))
      .filter((field) => !auditedFields.has(field));
    expect(uncovered).toEqual(["sourceWitness"]);
  });
});
