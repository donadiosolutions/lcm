import type { MigrationMismatchClass, MigrationVerificationReportBody } from "./verification-report.js";

/**
 * The synthesis-round rule (V5/V6): a witness recorded without a
 * comparison concludes nothing, and a prose audit table cannot audit
 * itself -- three separate review rounds found a decorative witness a
 * prose table was supposed to catch. This module is the machine-checked
 * replacement: a frozen inventory with stable IDs, enforced by
 * test/migration/witness-audit.test.ts against the actual report body
 * shape, not merely against itself.
 *
 * Four honest outcomes, not two, because "no live runtime comparison"
 * is not always the same defect:
 * - compared-live: an explicit runtime comparison exists this pass and
 *   something refuses or records a mismatch on difference.
 * - structurally-protected: no runtime comparison exists, but the
 *   witness's own construction makes divergence impossible, not merely
 *   unchecked.
 * - recorded-only-per-plan: the frozen plan or schema explicitly
 *   excludes this witness from a comparison (a named, deliberate carve-
 *   out), distinct from a witness nobody got around to comparing.
 * - accepted-trust-boundary: caller-supplied, bound into the report
 *   identity, and never independently re-derived this pass -- a stated
 *   trust boundary (synthesis S3), not a silent gap.
 *
 * Anything that cannot honestly claim one of these four is the exact
 * defect this file exists to make impossible to add silently.
 */
export type MigrationWitnessComparisonKind =
  | "compared-live"
  | "structurally-protected"
  | "recorded-only-per-plan"
  | "accepted-trust-boundary";

export type MigrationWitnessAuditEntry = Readonly<{
  /** Stable, never reused once published in a candidate a reviewer has read. */
  id: string;
  /** The MigrationVerificationReportBody field this witness's bytes live in. */
  bodyField: keyof MigrationVerificationReportBody;
  description: string;
  comparison: MigrationWitnessComparisonKind;
  /** What happens on a difference; for the three non-live kinds, states why there is deliberately no live comparison. */
  onDifference: string;
  /**
   * The closed mismatch classes this witness's live comparison can
   * produce, when comparison is "compared-live". Ties this inventory to
   * the driver's classCoverage vector (verify-generation.ts's
   * DRIVER_IMPLEMENTED_MISMATCH_CLASSES) so the two frozen mechanisms
   * cannot silently drift apart: every class the driver claims ran must
   * be traceable to a real, live-compared witness here, and vice versa.
   */
  mismatchClasses?: readonly MigrationMismatchClass[];
}>;

/**
 * Report-body fields that are identity or derived-digest plumbing, not
 * independently captured evidence: they are computed *from* the witnesses
 * below, or are the record's own identifiers, so auditing them as
 * witnesses in their own right would be circular.
 */
export const MIGRATION_WITNESS_AUDIT_EXCLUDED_BODY_FIELDS: ReadonlySet<keyof MigrationVerificationReportBody> = new Set([
  "version", "generationId", "targetGenerationId", "bindingSha256", "reconciliationOutcomeDigestSha256",
]);

export const MIGRATION_WITNESS_AUDIT: readonly MigrationWitnessAuditEntry[] = Object.freeze([
  {
    id: "source-witness", bodyField: "sourceWitness",
    description: "Source identity/schema/content witnesses, re-derived from the immutable snapshot artifact per step 1, never from the manifest.",
    comparison: "structurally-protected",
    onDifference: "n/a: identitySha256 is artifact.sourceSelectionSha256, and reauthenticate() re-proves the artifact unchanged under the publication barrier immediately around the read. A caller cannot substitute different bytes without a different generationId/homeDir, which opens a different generation entirely rather than producing drift within this one.",
  },
  {
    id: "destination-identity-sealed-witness", bodyField: "destinationIdentity",
    description: "The destination's re-derived sealed five-field identity witness.",
    comparison: "compared-live",
    onDifference: "refuses destination-drift when it disagrees with expectedDestinationIdentitySha256",
    mismatchClasses: ["identity"],
  },
  {
    id: "destination-system-identifier", bodyField: "destinationIdentity",
    description: "pg_control_system()'s system_identifier, recorded as a sibling of the sealed witness.",
    comparison: "compared-live",
    onDifference: "refuses destination-drift when it disagrees with expectedSystemIdentifier",
    mismatchClasses: ["identity"],
  },
  {
    id: "destination-schema-migrations", bodyField: "destinationSchemaWitness",
    description: "The destination's applied migrations chain digest.",
    comparison: "compared-live",
    onDifference: "refuses destination-drift when it disagrees with destinationMigrationsSha256",
    mismatchClasses: ["schema"],
  },
  {
    id: "destination-schema-search-configuration", bodyField: "destinationSchemaWitness",
    description: "The destination's text-search configuration digest.",
    comparison: "recorded-only-per-plan",
    onDifference: "n/a: plan-v4 step 2 names this an additional report witness, never folded into the migrations-only comparison; only its absence (null) refuses, never drift from an expected value",
  },
  {
    id: "destination-schema-collation", bodyField: "destinationSchemaWitness",
    description: "The destination's collation-sensitive column digest.",
    comparison: "recorded-only-per-plan",
    onDifference: "n/a: plan-v4 step 2's additional-witness carve-out, same as search configuration",
  },
  {
    id: "destination-schema-sequence-state-digest", bodyField: "destinationSchemaWitness",
    description: "A descriptive digest of destination sequence parameters (start/increment/is_called), distinct from the sequence-self-consistency-mismatches bound.",
    comparison: "recorded-only-per-plan",
    onDifference: "n/a: plan-v4 step 2's additional-witness carve-out; superseded in substance by the sequence-self-consistency entry below, which is the live comparison this schema field's name might otherwise be mistaken for",
  },
  {
    id: "census-per-domain", bodyField: "censusVector",
    description: "Per-domain destination recordCount and prefixSha256, read inside the fenced window.",
    comparison: "compared-live",
    onDifference: "records a count-class or digest-class mismatch per domain against the source checkpoint",
    mismatchClasses: ["count", "digest"],
  },
  {
    id: "canonical-delta", bodyField: "canonicalDelta",
    description: "Per-domain destination recordCount and terminalIdentitySha256, derived from the same census read.",
    comparison: "recorded-only-per-plan",
    onDifference: "n/a: delta equality permits nothing under the frozen schema rule; derived from the census rather than run as a separate read, and never itself compared against anything",
  },
  {
    id: "sequence-self-consistency", bodyField: "classCoverage",
    description: "Each identity sequence's last_value/is_called against the maximum copied identity in its domain, read fresh inside the window every pass; no witness value persists in the body, only the outcome.",
    comparison: "compared-live",
    onDifference: "records a sequence-class mismatch per domain",
    mismatchClasses: ["sequence"],
  },
  {
    id: "public-listing-probe", bodyField: "publicProbeSha256",
    description: "The destination's ordered-listing repository read, compared against the source's own canonical createdAt ordering captured during step 1.",
    comparison: "compared-live",
    onDifference: "records a sample-class mismatch on the public-listing pseudo-domain",
    mismatchClasses: ["sample"],
  },
  {
    id: "project-map-witness", bodyField: "projectMapWitnessSha256",
    description: "Caller-supplied project-map witness digest.",
    comparison: "accepted-trust-boundary",
    onDifference: "n/a: bound into the report identity but never independently re-derived by this driver (synthesis S3); a stated trust boundary, not a silent gap",
  },
  {
    id: "queue-classification-witness", bodyField: "queueClassificationWitness",
    description: "Caller-supplied sealed queue-classification witness (queue cutoff, queue set, receipt set, epoch checksum).",
    comparison: "accepted-trust-boundary",
    onDifference: "n/a: same trust boundary as the project-map witness; the snapshot's own queue evidence (copySource.snapshot.receiptReference) is available to re-derive this from but is not yet used to do so",
  },
  {
    id: "manifest-revision", bodyField: "manifestRevision",
    description: "Caller-supplied manifest revision number bound into the report identity.",
    comparison: "accepted-trust-boundary",
    onDifference: "n/a: caller-owned manifest lifecycle; this driver does not read the manifest store itself",
  },
  {
    id: "manifest-checksum", bodyField: "manifestChecksumSha256",
    description: "Caller-supplied manifest checksum bound into the report identity.",
    comparison: "accepted-trust-boundary",
    onDifference: "n/a: same trust boundary as manifest-revision",
  },
  {
    id: "sample-parameters", bodyField: "sampleParameters",
    description: "Caller-supplied frozen sample stride/count/seed-basis parameters.",
    comparison: "accepted-trust-boundary",
    onDifference: "n/a: a per-record stride sampler is not implemented anywhere in this driver pass; bound into the report identity but does not yet drive any sampling read",
  },
]);
