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
 * Round-1 review found the first version of this module itself
 * decorative: every non-live row was required to prefix its reason with
 * a bare "n/a" marker, and the only completeness check was field
 * coverage plus class-set equality -- so an uncompared witness with a
 * well-formed "n/a" row passed cleanly, and the enforced test shape
 * *forbade* a fix that named a missing comparison without the "n/a"
 * prefix. The mechanism built to catch a rule that had already failed
 * three times as prose was itself the decorative-witness pattern one
 * level up.
 *
 * The repair is structural rather than another string convention: each
 * comparison kind is its own object shape, and TypeScript will not let
 * an entry of a given kind omit that kind's required fields. A
 * `structurally-protected` entry cannot exist without naming both a
 * `comparator` and a `refusal`; a `recorded-only-per-plan` or
 * `accepted-trust-boundary` entry cannot exist without naming the exact
 * `missingComparison` and the `owningItem` that accepts the gap. There
 * is no bare "not applicable" shape left to construct. A non-empty-
 * string runtime check backs this up for the one thing TypeScript
 * itself cannot enforce -- that a required field was filled with real
 * content rather than an empty string.
 *
 * Four honest outcomes, not two, because "no live runtime comparison"
 * is not always the same defect:
 * - compared-live: an explicit runtime comparison exists this pass and
 *   something refuses or records a mismatch on difference. Names that
 *   consequence.
 * - structurally-protected: no runtime comparison exists, but the
 *   witness's own construction makes divergence impossible, not merely
 *   unchecked. Names the comparator whose construction provides that
 *   guarantee and the refusal path if it were somehow defeated anyway.
 * - recorded-only-per-plan: the frozen plan or schema explicitly
 *   excludes this witness from a comparison (a named, deliberate carve-
 *   out), distinct from a witness nobody got around to comparing. Names
 *   the exact comparison this witness does not have and the plan/schema
 *   clause that accepts the gap.
 * - accepted-trust-boundary: caller-supplied, bound into the report
 *   identity, and never independently re-derived this pass -- a stated
 *   trust boundary (synthesis S3), not a silent gap. Names the exact
 *   comparison this witness does not have and the item that accepts it.
 *
 * Anything that cannot honestly claim one of these four, with its kind's
 * required fields genuinely filled in, is the exact defect this file
 * exists to make impossible to add silently.
 *
 * Reconciliation (round-1 W4): plan-v4 step 2 described search-
 * configuration and collation as an "additional report witness" outside
 * the migrations-only comparison, without naming a live-to-live check.
 * witness-schema-FROZEN-v3.2.md's audit table, frozen later, names both
 * "compared against the live destination values, live-to-live" with
 * refusal. Per this item's standing rule that a later frozen document
 * corrects an earlier one where they disagree, v3.2 governs: both are
 * now compared-live in this inventory (assertSchemaWitnessLiveToLive in
 * verify-generation.ts), and plan-v4 step 2's carve-out language is
 * superseded for these two fields specifically. sequenceStateSha256
 * keeps its recorded-only-per-plan classification, since v3.2's own row
 * for that field names self-consistency -- the separate
 * sequence-self-consistency entry below -- not a live-to-live digest
 * comparison of this raw descriptive field.
 */
export type MigrationWitnessComparisonKind =
  | "compared-live"
  | "structurally-protected"
  | "recorded-only-per-plan"
  | "accepted-trust-boundary";

type MigrationWitnessAuditEntryCommon = Readonly<{
  /** Stable, never reused once published in a candidate a reviewer has read. */
  id: string;
  /** The MigrationVerificationReportBody field this witness's bytes live in. */
  bodyField: keyof MigrationVerificationReportBody;
  description: string;
}>;

export type MigrationWitnessAuditEntry =
  | (MigrationWitnessAuditEntryCommon & Readonly<{
      comparison: "compared-live";
      /** The real consequence when this witness disagrees this pass -- never a placeholder. */
      consequence: string;
      /**
       * The closed mismatch classes this witness's live comparison can
       * produce. Ties this inventory to the driver's classCoverage
       * vector (verify-generation.ts's DRIVER_IMPLEMENTED_MISMATCH_CLASSES)
       * so the two frozen mechanisms cannot silently drift apart: every
       * class the driver claims ran must be traceable to a real,
       * live-compared witness here, and vice versa.
       */
      mismatchClasses: readonly MigrationMismatchClass[];
    }>)
  | (MigrationWitnessAuditEntryCommon & Readonly<{
      comparison: "structurally-protected";
      /** The comparator whose own construction makes divergence impossible, named by mechanism, not merely asserted. */
      comparator: string;
      /** What refuses or records a mismatch if divergence somehow occurred anyway. */
      refusal: string;
    }>)
  | (MigrationWitnessAuditEntryCommon & Readonly<{
      comparison: "recorded-only-per-plan" | "accepted-trust-boundary";
      /** The exact comparison this witness does not have this pass. */
      missingComparison: string;
      /** The plan/schema clause or issue that accepts this gap, by name. */
      owningItem: string;
    }>);

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
    comparator: "copy-source.ts's reauthenticateHeld, which compares canonicalJson(authenticateSqliteMigrationSource(...)) against canonicalJson(authority) and canonicalJson(observed) against canonicalJson(snapshot), both re-derived fresh under the publication append barrier immediately around the read (once before streaming, once after, per verify-generation.ts's two copySource.reauthenticate() calls). A caller cannot substitute different bytes without a different generationId/homeDir, which opens a different generation entirely rather than producing drift within this one.",
    refusal: "copy-source.ts's refuse(), which throws synchronously and propagates out of the driver uncaught -- proven live by test/migration/copy-source.test.ts's symlink-swap case and by verify-generation.test.ts's 'refuses when reauthenticate detects the source changed between the two calls' case.",
  },
  {
    id: "destination-identity-sealed-witness", bodyField: "destinationIdentity",
    description: "The destination's re-derived sealed five-field identity witness.",
    comparison: "compared-live",
    consequence: "refuses destination-drift when it disagrees with expectedDestinationIdentitySha256",
    mismatchClasses: ["identity"],
  },
  {
    id: "destination-system-identifier", bodyField: "destinationIdentity",
    description: "pg_control_system()'s system_identifier, recorded as a sibling of the sealed witness.",
    comparison: "compared-live",
    consequence: "refuses destination-drift when it disagrees with expectedSystemIdentifier",
    mismatchClasses: ["identity"],
  },
  {
    id: "destination-schema-migrations", bodyField: "destinationSchemaWitness",
    description: "The destination's applied migrations chain digest.",
    comparison: "compared-live",
    consequence: "refuses destination-drift when it disagrees with destinationMigrationsSha256",
    mismatchClasses: ["schema"],
  },
  {
    id: "destination-schema-search-configuration", bodyField: "destinationSchemaWitness",
    description: "The destination's text-search configuration digest.",
    comparison: "compared-live",
    consequence: "refuses destination-drift (round-1 W4 fix): compared against a second live read from inside the fenced window, on the same borrowed read-only session as the census -- witness-schema-FROZEN-v3.2.md's audit row names this comparison live-to-live, since a manifest-sealed baseline from copy time does not exist for this value the way it does for migrations",
    mismatchClasses: ["schema"],
  },
  {
    id: "destination-schema-collation", bodyField: "destinationSchemaWitness",
    description: "The destination's collation-sensitive column digest.",
    comparison: "compared-live",
    consequence: "refuses destination-drift (round-1 W4 fix), same live-to-live mechanism as search configuration",
    mismatchClasses: ["schema"],
  },
  {
    id: "destination-schema-sequence-state-digest", bodyField: "destinationSchemaWitness",
    description: "A descriptive digest of destination sequence parameters (start/increment/is_called), distinct from the sequence-self-consistency-mismatches bound.",
    comparison: "recorded-only-per-plan",
    missingComparison: "no live-to-live comparison of this descriptive digest itself",
    owningItem: "plan-v4 step 2's additional-witness carve-out; superseded in substance by the sequence-self-consistency entry below, which is the live comparison this schema field's name might otherwise be mistaken for",
  },
  {
    id: "census-per-domain", bodyField: "censusVector",
    description: "Per-domain destination recordCount and prefixSha256, read inside the fenced window.",
    comparison: "compared-live",
    consequence: "records a count-class or digest-class mismatch per domain against the source checkpoint",
    mismatchClasses: ["count", "digest"],
  },
  {
    id: "canonical-delta", bodyField: "canonicalDelta",
    description: "Per-domain destination recordCount and terminalIdentitySha256, derived from the same census read.",
    comparison: "recorded-only-per-plan",
    missingComparison: "delta equality is never itself compared against anything and permits nothing under the frozen schema rule",
    owningItem: "the frozen witness schema's 'delta equality permits nothing' rule; derived from the census rather than run as a separate read",
  },
  {
    id: "sequence-self-consistency", bodyField: "classCoverage",
    description: "Each identity sequence's last_value/is_called against the maximum copied identity in its domain, read fresh inside the window every pass; no witness value persists in the body, only the outcome.",
    comparison: "compared-live",
    consequence: "records a sequence-class mismatch per domain",
    mismatchClasses: ["sequence"],
  },
  {
    id: "relation-edge-set", bodyField: "classCoverage",
    description: "Per-domain dependency-edge-set equality between source and destination in canonical identity terms (PortableRecord.dependencies, already computed by the existing canonicalisation path on both sides), read fresh inside the window every pass; no witness value persists in the body, only the outcome. Catches a child remapped to a valid but wrong parent -- the #623 P1 shape -- which a foreign-key constraint cannot see because the remapped reference still points at a real row.",
    comparison: "compared-live",
    consequence: "records a relation-class mismatch per domain naming the child's identity digest, never the parent's",
    mismatchClasses: ["relation"],
  },
  {
    id: "relation-dangling-reference", bodyField: "classCoverage",
    description: "Cheap additional guard, read from the same data the edge-set comparison already collected: every dependency edge the destination itself recorded must resolve to a record that actually exists there. Defense in depth against a foreign-key constraint bypass (disabled triggers, an unvalidated FK); ordinary PostgreSQL writes make this structurally unreachable, which is why it is the secondary check and edge-set equality is the substantive one.",
    comparison: "compared-live",
    consequence: "records a relation-class mismatch per domain naming the child's identity digest",
    mismatchClasses: ["relation"],
  },
  {
    id: "ledger-transfer-run", bodyField: "classCoverage",
    description: "lcm.transfer_runs, read fresh inside the window: state must be completed, and run_id/target_generation/manifest_sha256 (against the source stream's own describe().manifestSha256) must match the bound values. project_sha256 is compared against probePostgreSqlPortableDestination's identityFingerprintSha256, obtained via the existing canonicalisation path at step 2 rather than re-derived here.",
    comparison: "compared-live",
    consequence: "records a ledger-class mismatch on the ledger pseudo-domain when the run is missing, not completed, or any bound value disagrees",
    mismatchClasses: ["ledger"],
  },
  {
    id: "ledger-transfer-batches", bodyField: "classCoverage",
    description: "lcm.transfer_batches, read fresh inside the window: each of the 22 domains' terminal (highest next_ordinal) batch must carry a checkpoint_sha256 and next_ordinal matching the caller-supplied manifest's own checkpoints array, consumed directly rather than restated.",
    comparison: "compared-live",
    consequence: "records a ledger-class mismatch naming the domain whose terminal batch is missing or disagrees with the manifest",
    mismatchClasses: ["ledger"],
  },
  {
    id: "ledger-transfer-identities", bodyField: "classCoverage",
    description: "lcm.transfer_identities, read fresh inside the window: row count for the run must equal the census total record count, and the native_key-to-identity_sha256 mapping must be injective per domain. A non-injective mapping is the storage-level signature of the same wrong-parent defect the relation class catches at the edge level.",
    comparison: "compared-live",
    consequence: "records a ledger-class mismatch (cardinality on the ledger pseudo-domain, or per domain for a non-injective mapping)",
    mismatchClasses: ["ledger"],
  },
  {
    id: "public-listing-probe", bodyField: "publicProbeSha256",
    description: "The destination's ordered-listing repository read, compared against the source's own canonical createdAt ordering captured during step 1.",
    comparison: "compared-live",
    consequence: "records a sample-class mismatch on the public-listing pseudo-domain",
    mismatchClasses: ["sample"],
  },
  {
    id: "search-self-match-probe", bodyField: "publicProbeSha256",
    description: "The plan-v4 step 5 lcm.search_v1 search probe: PostgreSqlLexicalSearchRepository.searchMessages, run before the window through the real repository, walking a bounded pool of source message candidates starting at an index derived from sampleParameters.seedBasisSha256 until one candidate's own content produces a non-empty destination search result (a self-match, never a cross-engine comparison against SQLite's own search behaviour).",
    comparison: "compared-live",
    consequence: "when a match is found, folds ran plus the chosen candidate's canonical ordinal into publicProbeSha256, and the sample class's classCoverage bit is true; when every candidate in the pool is exhausted without a match, folds the not-run reason into publicProbeSha256 instead, the sample class's classCoverage bit is false, and activationEligible cannot be true this pass -- an attributed absence per the frozen absence rule, not a mismatch and not a silent pass",
    mismatchClasses: ["sample"],
  },
  {
    id: "project-map-witness", bodyField: "projectMapWitnessSha256",
    description: "Caller-supplied project-map witness digest.",
    comparison: "accepted-trust-boundary",
    missingComparison: "never independently re-derived by this driver",
    owningItem: "synthesis S3's stated trust boundary; bound into the report identity, not a silent gap",
  },
  {
    id: "queue-classification-witness", bodyField: "queueClassificationWitness",
    description: "Caller-supplied sealed queue-classification witness (queue cutoff, queue set, receipt set, epoch checksum).",
    comparison: "accepted-trust-boundary",
    missingComparison: "the snapshot's own queue evidence (copySource.snapshot.receiptReference) is available to re-derive this from but is not yet used to do so",
    owningItem: "synthesis S3, same trust boundary as project-map-witness",
  },
  {
    id: "manifest-revision", bodyField: "manifestRevision",
    description: "Caller-supplied manifest revision number bound into the report identity.",
    comparison: "accepted-trust-boundary",
    missingComparison: "this driver does not read the manifest store to compare its revision against a live value",
    owningItem: "the caller-owned manifest lifecycle",
  },
  {
    id: "manifest-checksum", bodyField: "manifestChecksumSha256",
    description: "Caller-supplied manifest checksum bound into the report identity.",
    comparison: "accepted-trust-boundary",
    missingComparison: "this driver does not read the manifest store to compare its checksum against a live value",
    owningItem: "the caller-owned manifest lifecycle, same trust boundary as manifest-revision",
  },
  {
    id: "sample-parameters", bodyField: "sampleParameters",
    description: "Caller-supplied frozen sample stride/count/seed-basis parameters. seedBasisSha256 now drives search-self-match-probe's candidate walk (see that entry); strideOrdinal and sampleCount remain unused by any per-record stride sampler, which this driver pass does not implement.",
    comparison: "accepted-trust-boundary",
    missingComparison: "strideOrdinal and sampleCount do not drive any per-record stride sampler, which this driver pass does not implement; bound into the report identity but otherwise inert",
    owningItem: "plan-v4's sampling scope, not yet implemented",
  },
]);
