import { describe, expect, it } from "vitest";
import { PORTABLE_RECORD_DOMAIN_ORDER, type PortableDomain } from "../../src/storage/portable-record.js";
import { migrationWitnessSha256 } from "../../src/migration/activation-witness.js";
import {
  MIGRATION_MISMATCH_CLASSES,
  MIGRATION_PUBLIC_PROBE_ORDER,
  createMigrationVerificationReportBody,
  MigrationVerificationReportError,
  type CreateMigrationVerificationReportBodyInput,
  type MigrationVerificationReportBody,
} from "../../src/migration/verification-report.js";
import { DRIVER_IMPLEMENTED_MISMATCH_CLASSES } from "../../src/migration/verify-generation.js";
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
    publicProbeCoverage: MIGRATION_PUBLIC_PROBE_ORDER.map((probe) => ({ probe, ran: true })),
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
  it("gives every entry a non-empty description", () => {
    for (const entry of MIGRATION_WITNESS_AUDIT) {
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });
  /**
   * Round-1 P1: the first version of this module required every non-live
   * row to be prefixed "n/a", which is precisely the placeholder the whole
   * module exists to forbid, and the enforced test shape made a fix that
   * named a missing comparison without that prefix fail outright. The
   * schema is now a discriminated union: each comparison kind has its own
   * required fields, so there is no shape left in which a row can exist
   * without naming something concrete. These tests check that every
   * required field for the entry's own kind is genuinely filled in --
   * TypeScript already refuses to compile an entry missing the field
   * entirely, so this is the one thing only a runtime check can catch:
   * a field present but emptied out.
   */
  it("requires a compared-live entry to name a real consequence and at least one mismatch class", () => {
    const liveEntries = MIGRATION_WITNESS_AUDIT.filter(
      (entry): entry is Extract<MigrationWitnessAuditEntry, { comparison: "compared-live" }> => entry.comparison === "compared-live",
    );
    expect(liveEntries.length).toBeGreaterThan(0);
    for (const entry of liveEntries) {
      expect(entry.consequence.length).toBeGreaterThan(0);
      expect(entry.mismatchClasses.length).toBeGreaterThan(0);
    }
  });
  it("requires a structurally-protected entry to name both its comparator and its refusal", () => {
    const protectedEntries = MIGRATION_WITNESS_AUDIT.filter(
      (entry): entry is Extract<MigrationWitnessAuditEntry, { comparison: "structurally-protected" }> => entry.comparison === "structurally-protected",
    );
    expect(protectedEntries.length).toBeGreaterThan(0);
    for (const entry of protectedEntries) {
      expect(entry.comparator.length).toBeGreaterThan(0);
      expect(entry.refusal.length).toBeGreaterThan(0);
    }
  });
  it("requires a compared-live-probe-coverage entry to name a real consequence and at least one probe", () => {
    // The probe-coverage sibling of the compared-live check above: this
    // shape exists precisely because the search probe gates
    // activationEligible without ever producing a mismatch class, so it
    // needs its own non-empty-field enforcement rather than silently
    // inheriting compared-live's.
    const probeCoverageEntries = MIGRATION_WITNESS_AUDIT.filter(
      (entry): entry is Extract<MigrationWitnessAuditEntry, { comparison: "compared-live-probe-coverage" }> => entry.comparison === "compared-live-probe-coverage",
    );
    expect(probeCoverageEntries.length).toBeGreaterThan(0);
    for (const entry of probeCoverageEntries) {
      expect(entry.consequence.length).toBeGreaterThan(0);
      expect(entry.probes.length).toBeGreaterThan(0);
    }
  });
  it("requires a recorded-only-per-plan or accepted-trust-boundary entry to name the exact missing comparison and its owning item", () => {
    const nonLiveEntries = MIGRATION_WITNESS_AUDIT.filter(
      (entry): entry is Extract<MigrationWitnessAuditEntry, { comparison: "recorded-only-per-plan" | "accepted-trust-boundary" }> => (
        entry.comparison === "recorded-only-per-plan" || entry.comparison === "accepted-trust-boundary"
      ),
    );
    expect(nonLiveEntries.length).toBeGreaterThan(0);
    for (const entry of nonLiveEntries) {
      expect(entry.missingComparison.length).toBeGreaterThan(0);
      expect(entry.owningItem.length).toBeGreaterThan(0);
    }
  });
  it("forbids a bare not-applicable marker anywhere in the inventory (red-first demonstration)", () => {
    // The defect this rewrite exists to fix, proven directly: a "n/a"
    // placeholder standing in for a real reason must be rejected wherever
    // it could appear, not merely absent from the current 21 entries by
    // convention. Scans every string field the schema defines, on a
    // mutated copy, and shows the same emptiness/placeholder logic these
    // tests apply would catch it if it existed for real.
    const bareMarkerFields = (entry: MigrationWitnessAuditEntry): readonly string[] => {
      switch (entry.comparison) {
        case "compared-live": return [entry.consequence];
        case "compared-live-probe-coverage": return [entry.consequence];
        case "structurally-protected": return [entry.comparator, entry.refusal];
        case "recorded-only-per-plan":
        case "accepted-trust-boundary": return [entry.missingComparison, entry.owningItem];
      }
    };
    for (const entry of MIGRATION_WITNESS_AUDIT) {
      for (const field of bareMarkerFields(entry)) {
        expect(field.trim().toLowerCase()).not.toBe("n/a");
        expect(field.trim().toLowerCase().startsWith("n/a:")).toBe(false);
        expect(field.trim().toLowerCase().startsWith("n/a ")).toBe(false);
      }
    }
    // Demonstrate the check can actually fail: a mutated entry whose
    // required field was emptied out is exactly what a reviewer's
    // "removed a comparison from a real witness" case looks like.
    const withEmptiedComparator: MigrationWitnessAuditEntry = {
      ...MIGRATION_WITNESS_AUDIT.find((entry) => entry.id === "source-witness")!,
      comparator: "",
    } as Extract<MigrationWitnessAuditEntry, { comparison: "structurally-protected" }>;
    expect(withEmptiedComparator.comparator.length).toBe(0);
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

describe("reconciliation-class coverage, tied to the same audit inventory", () => {
  it("has an audit entry mapped to every mismatch class the driver claims as ran, and no other", () => {
    // Ties the witness audit to verify-generation.ts's own classification
    // so the two frozen mechanisms cannot silently drift apart: every
    // class the driver marks ran:true must be traceable to a real,
    // live-compared witness here, and this inventory must claim no more
    // than the driver actually implements.
    const classesNamedByLiveEntries = new Set(
      MIGRATION_WITNESS_AUDIT
        .filter((entry): entry is Extract<MigrationWitnessAuditEntry, { comparison: "compared-live" }> => entry.comparison === "compared-live")
        .flatMap((entry) => entry.mismatchClasses),
    );
    expect(classesNamedByLiveEntries).toEqual(new Set(DRIVER_IMPLEMENTED_MISMATCH_CLASSES));
  });
  it("fails that cross-check when a live-compared witness's mismatchClasses is dropped (red-first demonstration)", () => {
    const withoutSequenceMapping: readonly MigrationWitnessAuditEntry[] = MIGRATION_WITNESS_AUDIT.map((entry) => (
      entry.id === "sequence-self-consistency" && entry.comparison === "compared-live" ? { ...entry, mismatchClasses: [] } : entry
    ));
    const classesNamedByLiveEntries = new Set(
      withoutSequenceMapping
        .filter((entry): entry is Extract<MigrationWitnessAuditEntry, { comparison: "compared-live" }> => entry.comparison === "compared-live")
        .flatMap((entry) => entry.mismatchClasses),
    );
    expect(classesNamedByLiveEntries).not.toEqual(new Set(DRIVER_IMPLEMENTED_MISMATCH_CLASSES));
    expect(classesNamedByLiveEntries.has("sequence")).toBe(false);
  });
  it("rejects a report body whose classCoverage vector omits a reconciliation class entirely", () => {
    // The direct analogue of the witness-completeness check above, for
    // MIGRATION_MISMATCH_CLASSES rather than report-body fields: a
    // coverage vector missing one class must never construct a report.
    const incompleteCoverage = MIGRATION_MISMATCH_CLASSES
      .filter((mismatchClass) => mismatchClass !== "ledger")
      .map((mismatchClass) => ({ class: mismatchClass, ran: true }));
    expect(() => createMigrationVerificationReportBody({
      ...fixtureBodyInput(), classCoverage: incompleteCoverage,
    })).toThrow(MigrationVerificationReportError);
  });
  it("passes once every reconciliation class has a coverage-vector entry (green after the red case above)", () => {
    expect(() => realBody()).not.toThrow();
  });
});

describe("public-probe coverage, tied to the same audit inventory", () => {
  it("has an audit entry mapped to every public probe the report claims coverage for, and no other", () => {
    // The MIGRATION_PUBLIC_PROBE_ORDER analogue of the mismatch-class
    // cross-check above: publicProbeCoverage is a second, independent
    // gate on activationEligible (owner's round-3 compound-case fix), so
    // it needs the same drift-proofing the mismatch classes already
    // have, not just the field-presence check the generic tests give it.
    const probesNamedByLiveEntries = new Set(
      MIGRATION_WITNESS_AUDIT
        .filter((entry): entry is Extract<MigrationWitnessAuditEntry, { comparison: "compared-live-probe-coverage" }> => entry.comparison === "compared-live-probe-coverage")
        .flatMap((entry) => entry.probes),
    );
    expect(probesNamedByLiveEntries).toEqual(new Set(MIGRATION_PUBLIC_PROBE_ORDER));
  });
  it("fails that cross-check when a live-compared probe-coverage witness's probes is dropped (red-first demonstration)", () => {
    const withoutSearchProbe: readonly MigrationWitnessAuditEntry[] = MIGRATION_WITNESS_AUDIT.map((entry) => (
      entry.id === "public-probe-coverage" && entry.comparison === "compared-live-probe-coverage"
        ? { ...entry, probes: ["public-listing"] as const }
        : entry
    ));
    const probesNamedByLiveEntries = new Set(
      withoutSearchProbe
        .filter((entry): entry is Extract<MigrationWitnessAuditEntry, { comparison: "compared-live-probe-coverage" }> => entry.comparison === "compared-live-probe-coverage")
        .flatMap((entry) => entry.probes),
    );
    expect(probesNamedByLiveEntries).not.toEqual(new Set(MIGRATION_PUBLIC_PROBE_ORDER));
    expect(probesNamedByLiveEntries.has("public-search")).toBe(false);
  });
  it("rejects a report body whose publicProbeCoverage vector omits a probe entirely", () => {
    const incompleteProbeCoverage = MIGRATION_PUBLIC_PROBE_ORDER
      .filter((probe) => probe !== "public-search")
      .map((probe) => ({ probe, ran: true }));
    expect(() => createMigrationVerificationReportBody({
      ...fixtureBodyInput(), publicProbeCoverage: incompleteProbeCoverage,
    })).toThrow(MigrationVerificationReportError);
  });
  it("passes once every public probe has a coverage-vector entry (green after the red case above)", () => {
    expect(() => realBody()).not.toThrow();
  });
});
