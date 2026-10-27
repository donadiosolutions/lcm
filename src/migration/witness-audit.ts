import type { MigrationMismatchClass, MigrationPublicProbeName, MigrationVerificationReportBody } from "./verification-report.js";
import type { MigrationVerificationReceiptId } from "./verify-generation.js";

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
  | "compared-live-probe-coverage"
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
       * vector so the two frozen mechanisms cannot silently drift apart:
       * every class a completion receipt can mark as run must be
       * traceable to a real, live-compared witness here, and vice versa.
       */
      mismatchClasses: readonly MigrationMismatchClass[];
      /**
       * The completion receipts whose comparators perform this live
       * comparison, by id in verify-generation.ts's
       * MIGRATION_VERIFICATION_COMPARATORS registry. A row cannot claim a
       * comparison unless the registry names exported comparator functions
       * for it; the audit test resolves every id and checks that.
       */
      receipts: readonly MigrationVerificationReceiptId[];
    }>)
  | (MigrationWitnessAuditEntryCommon & Readonly<{
      comparison: "compared-live-probe-coverage";
      /** The real consequence when this witness disagrees this pass -- never a placeholder. */
      consequence: string;
      /**
       * The public probes this witness's liveness gates, via
       * publicProbeCoverage rather than a mismatch class. Round-2 P1's
       * search probe is the reason this shape exists: it gates
       * activationEligible on its own outcome without ever producing a
       * MigrationVerificationMismatch, so "compared-live"'s
       * mismatchClasses requirement (which the audit test enforces as
       * non-empty) cannot honestly describe it. Ties this inventory to
       * MIGRATION_PUBLIC_PROBE_ORDER so the two cannot silently drift
       * apart, the same discipline compared-live's mismatchClasses
       * applies to classCoverage.
       */
      probes: readonly MigrationPublicProbeName[];
      /** The completion receipts that mark these probes as run; see compared-live's receipts. */
      receipts: readonly MigrationVerificationReceiptId[];
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
    consequence: "refuses destination-drift when it disagrees with the sealed manifest's destination.identitySha256 or with expectedDestinationIdentitySha256 (the five-field witness -- database name, database OID, server address, server port and project id -- is what binds the physical target); resuming a pending verification effect applies the same manifest comparison to the persisted report's sealed witness, without reopening the destination",
    mismatchClasses: ["identity"],
    receipts: ["identity"],
  },
  {
    id: "destination-system-identifier", bodyField: "destinationIdentity",
    description: "pg_control_system()'s system_identifier, captured once before the fenced window opens and compared with the value the copy recorded in the manifest's destination witness.",
    comparison: "compared-live",
    consequence: "refuses destination-drift when the manifest's destination witness has no recorded system identifier (a manifest written before the copy recorded it; recopy), when it disagrees with that recorded value, or when it disagrees with expectedSystemIdentifier (all compared pre-window); round-4 also rechecks it live-to-live from inside the fenced window, on the same borrowed read-only session as the census, refusing destination-drift on a failover between the pre-lease read and the window that the pre-window comparison alone cannot see",
    mismatchClasses: ["identity"],
    receipts: ["identity", "schema"],
  },
  {
    id: "destination-schema-migrations", bodyField: "destinationSchemaWitness",
    description: "The destination's applied migrations chain digest, captured once before the fenced window opens.",
    comparison: "compared-live",
    consequence: "refuses destination-drift when it disagrees with destinationMigrationsSha256 (compared pre-window); round-4 also rechecks it live-to-live from inside the fenced window, on the same borrowed read-only session as the census, refusing destination-drift on a migration committing between the pre-lease read and the window that the pre-window comparison alone cannot see",
    mismatchClasses: ["schema"],
    receipts: ["schema"],
  },
  {
    id: "destination-schema-search-configuration", bodyField: "destinationSchemaWitness",
    description: "The destination's text-search configuration digest, captured once before the fenced window opens.",
    comparison: "compared-live",
    consequence: "two independent live comparisons, not one: (1) round-3 P2's pinned check -- the pre-window read itself is compared against the compiled-in POSTGRESQL_SEARCH_CONFIGURATION_SHA256 constant the schema installer enforces, refusing invalid-input on a stable-but-wrong configuration that a live-to-live check alone cannot see, since a value that never changes agrees with itself; (2) round-1 W4's fix -- that same pre-window read is compared against a second live read from inside the fenced window, on the same borrowed read-only session as the census, refusing destination-drift on a change between the two reads. Neither subsumes the other: (1) catches a wrong value that is stable across the whole pass, (2) catches a right value that becomes wrong mid-pass. witness-schema-FROZEN-v3.2.md's audit row names the second comparison live-to-live, since a manifest-sealed per-generation baseline from copy time does not exist for this value the way it does for migrations; the pinned constant is a build-level baseline, not a per-generation one, so it does not fill that gap on its own",
    mismatchClasses: ["schema"],
    receipts: ["schema"],
  },
  {
    id: "destination-schema-collation", bodyField: "destinationSchemaWitness",
    description: "The destination's collation-sensitive column digest.",
    comparison: "compared-live",
    consequence: "refuses destination-drift (round-1 W4 fix), same live-to-live mechanism as search configuration",
    mismatchClasses: ["schema"],
    receipts: ["schema"],
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
    receipts: ["count-digest"],
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
    receipts: ["sequence"],
  },
  {
    id: "relation-edge-set", bodyField: "classCoverage",
    description: "Per-domain dependency-edge-set equality between source and destination in canonical identity terms (PortableRecord.dependencies, already computed by the existing canonicalisation path on both sides), read fresh inside the window every pass; no witness value persists in the body, only the outcome. Catches a child remapped to a valid but wrong parent -- the #623 P1 shape -- which a foreign-key constraint cannot see because the remapped reference still points at a real row. Round-2-review stated scope reduction, not silently assumed complete: this equality check does not independently re-verify summary-parent-links acyclicity (a structurally cyclic chain of otherwise-individually-correct edges would not be caught, since set equality alone cannot see cycle structure) or re-derive project-aliases normalisation from source paths (it compares the already-normalised identities PortableRecord.dependencies carries on both sides, the same mechanism every other domain uses, rather than a bespoke per-domain re-normalisation pass); see verify-generation.ts's module-level scope-note comment for the same statement in the driver's own source.",
    comparison: "compared-live",
    consequence: "records a relation-class mismatch per domain naming the child's identity digest, never the parent's",
    mismatchClasses: ["relation"],
    receipts: ["relation"],
  },
  {
    id: "relation-dangling-reference", bodyField: "classCoverage",
    description: "Cheap additional guard, read from the same data the edge-set comparison already collected: every dependency edge the destination itself recorded must resolve to a record that actually exists there. Defense in depth against a foreign-key constraint bypass (disabled triggers, an unvalidated FK); ordinary PostgreSQL writes make this structurally unreachable, which is why it is the secondary check and edge-set equality is the substantive one.",
    comparison: "compared-live",
    consequence: "records a relation-class mismatch per domain naming the child's identity digest",
    mismatchClasses: ["relation"],
    receipts: ["relation"],
  },
  {
    id: "ledger-transfer-run", bodyField: "classCoverage",
    description: "lcm.transfer_runs, read fresh inside the window: state must be completed, and run_id/target_generation/manifest_sha256 (against the source stream's own describe().manifestSha256) must match the bound values. project_sha256 is compared against probePostgreSqlPortableDestination's identityFingerprintSha256, obtained via the existing canonicalisation path at step 2 rather than re-derived here.",
    comparison: "compared-live",
    consequence: "records a ledger-class mismatch on the ledger pseudo-domain when the run is missing, not completed, or any bound value disagrees",
    mismatchClasses: ["ledger"],
    receipts: ["ledger"],
  },
  {
    id: "ledger-transfer-batches", bodyField: "classCoverage",
    description: "lcm.transfer_batches, read fresh inside the window: every batch row of the run is read, and each of the 22 domains must hold exactly one contiguous chain (first prior is the copy's initial prior at ordinal 0, each later prior and first_ordinal continue the previous checkpoint and next_ordinal, no orphan, surplus or forked row) whose terminal checkpoint_sha256 and next_ordinal match the caller-supplied manifest's own checkpoints array, consumed directly rather than restated.",
    comparison: "compared-live",
    consequence: "records a ledger-class mismatch naming the domain whose batch chain is missing, broken, carries surplus rows, or whose terminal batch disagrees with the manifest",
    mismatchClasses: ["ledger"],
    receipts: ["ledger"],
  },
  {
    id: "ledger-transfer-identities", bodyField: "classCoverage",
    description: "lcm.transfer_identities, read fresh inside the window: row count for the run must equal the census total record count, and the native_key-to-identity_sha256 mapping must be injective per domain. A non-injective mapping is the storage-level signature of the same wrong-parent defect the relation class catches at the edge level.",
    comparison: "compared-live",
    consequence: "records a ledger-class mismatch (cardinality on the ledger pseudo-domain, or per domain for a non-injective mapping)",
    mismatchClasses: ["ledger"],
    receipts: ["ledger"],
  },
  {
    id: "public-listing-probe", bodyField: "publicProbeSha256",
    description: "The destination's ordered-listing repository read, compared against the source's own canonical (createdAt, identitySha256, title) entries captured during step 1. Both sides are grouped by createdAt truncated to the millisecond and each group's [identitySha256, title] pairs are compared as a sorted multiset rather than positionally, because the destination ties same-millisecond rows by its native conversation id and the source by portable identity, independent keys that disagree on a correct copy. The destination identity is the conversation's portable identity, derived by the exported derivation in portable-record.ts from the conversation's own columns read with the portable mapping's microsecond to_char projection (a JavaScript Date drops the digits the fingerprint is computed from), with identical headers numbered 0..n-1 as the source's occurrence ordinals are as a set; no transfer ledger is read. Two same-millisecond conversations that trade titles, a substituted record and a wrong title from the public read path all change a group's pairs. It remains a probe, not a proof: it covers the listing read path and the conversation headers, not every public read.",
    comparison: "compared-live",
    consequence: "records a sample-class mismatch on the public-listing pseudo-domain",
    mismatchClasses: ["sample"],
    receipts: ["public-listing"],
  },
  {
    id: "public-probe-coverage", bodyField: "publicProbeCoverage",
    description: "publicProbeCoverage's two entries: public-listing is true only when its completion receipt was recorded, that is when runOrderedListingProbe returned this pass; public-search is the plan-v4 step 5 lcm.search_v1 search probe -- PostgreSqlLexicalSearchRepository.searchMessages, run before the window through the real repository, walking a bounded pool of source message candidates starting at an index derived from sampleParameters.seedBasisSha256 until one candidate's own content produces a *confirmed* destination search result (a self-match, never a cross-engine comparison against SQLite's own search behaviour). Round-4 P1: confirmation means the candidate's source-space identitySha256 is correlated to the destination's native message_id through lcm.transfer_identities and that native key is checked against the actual search results -- a bare non-empty result is no longer sufficient, since a search path that ignores its query or returns a fixed unrelated result would otherwise pass every attempt. This borrows trust from one ledger row per candidate tried: a false pass now requires both a broken search and a transfer_identities row that happens to name exactly the message the broken search returned. An empty project (#1676) has no candidate: after the same completed-run lookup, the production searchMessages runs once on a fixed query and must return zero rows, and the receipt is earned only when the source messages checkpoint and the fenced destination census both report zero messages.",
    comparison: "compared-live-probe-coverage",
    consequence: "public-listing's entry is true only when runOrderedListingProbe returned; a pass that did not invoke it records false and cannot be activation-eligible. For public-search: when a correlated self-match is confirmed, folds ran plus the candidate pool size and the chosen candidate's canonical ordinal into publicProbeSha256, and its entry is true; when every candidate in the pool is exhausted without a confirmed self-match -- whether because a candidate's identity had no correlating transfer_identities row (unattributable) or because a search ran but did not return that candidate's own native key (unconfirmed) -- folds the not-run reason into publicProbeSha256 instead, its entry is false, and activationEligible cannot be true this pass regardless of what the listing probe or any mismatch class found -- an attributed absence per the frozen absence rule, not a mismatch and not a silent pass. For an empty project (#1676) the entry is true, and a constant empty-source tuple is folded, only when a completed transfer run exists, the fixed-query production search returned zero rows, and both the source messages checkpoint and the fenced destination census report zero messages; every other empty-pool outcome folds a string reason that carries no row or message count, and its entry stays false",
    probes: ["public-listing", "public-search"],
    receipts: ["public-listing", "public-search"],
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
    description: "Caller-supplied frozen sample stride/count/seed-basis parameters. seedBasisSha256 now drives public-probe-coverage's search candidate walk (see that entry); strideOrdinal and sampleCount remain unused by any per-record stride sampler, which this driver pass does not implement.",
    comparison: "accepted-trust-boundary",
    missingComparison: "strideOrdinal and sampleCount do not drive any per-record stride sampler, which this driver pass does not implement; bound into the report identity but otherwise inert",
    owningItem: "plan-v4's sampling scope, not yet implemented",
  },
]);
