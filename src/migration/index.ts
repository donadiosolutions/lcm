export * from "./manifest-store.js";
export * from "./protocol.js";
export {
  assertMigrationReplayAdmission,
  authenticateSqliteMigrationSource,
  authenticateSqliteMigrationSourceBytes,
  captureAuthenticatedSqliteMigrationSource,
  classifyImmutableSqliteSnapshot,
  dryRunAuthenticatedSqliteMigrationSource,
  inspectImmutableSqliteSnapshot,
  prepareSqliteMigrationEnrollment,
} from "./maintenance.js";
export type {
  SqliteMigrationEnrollmentDependencies,
  SqliteMigrationEnrollmentInput,
  SqliteMigrationEnrollmentResult,
} from "./maintenance.js";
export { SqliteSnapshotError } from "./sqlite-snapshot.js";
export type {
  AuthenticatedSqliteSnapshotAuthority,
  SqliteSnapshotArtifactRoleWitness,
  SqliteSnapshotArtifactWitness,
  SqliteSnapshotClassification,
  SqliteSnapshotDirectoryIdentity,
  SqliteSnapshotDryRun,
  SqliteSnapshotErrorReason,
  SqliteSnapshotFileIdentity,
  SqliteSnapshotPrivateFileWitness,
  SqliteSnapshotRole,
  SqliteSnapshotSourceByteWitness,
  SqliteSnapshotSourceRoleWitness,
} from "./sqlite-snapshot.js";

export { inspectAuthenticatedSqliteMigrationSnapshot } from "./queue-evidence.js";
export type { AuthenticatedSqliteMigrationSnapshot, MigrationReceiptReference } from "./queue-evidence.js";
export { runSqliteMigrationCopy, inspectSqliteMigrationCopy, MigrationCopyError } from './batch-copy.js';
export type { SqliteMigrationCopyInput, MigrationCopyBoundary, MigrationCopyTestingDependencies } from './batch-copy.js';

// --- #624: activation witness schema (frozen, pure, no I/O) ----------------

export {
  MigrationActivationWitnessError,
  migrationWitnessSha256,
  parseMigrationSelectionAuthority,
  parseMigrationDestinationIdentity,
  parseMigrationCanonicalDelta,
  migrationCanonicalDeltaChanged,
  parseMigrationCensusVector,
  migrationCensusVectorsEqual,
  parseMigrationSchemaWitness,
  createMigrationOpaqueEvidence,
  parseMigrationOpaqueEvidence,
  createMigrationQuiescenceFence,
  parseMigrationQuiescenceFence,
  createMigrationIntraActivationWatermark,
  parseMigrationIntraActivationWatermark,
  deriveMigrationActivationEpochId,
  createMigrationActivationEpoch,
  parseMigrationActivationEpoch,
  deriveMigrationActivationAttemptId,
  createMigrationActivationAttempt,
  parseMigrationActivationAttempt,
  migrationActivationCensusMatchVerdict,
  createMigrationActivationWitness,
  parseMigrationActivationWitness,
  classifyMigrationRollbackMode,
} from "./activation-witness.js";
export type {
  MigrationActivationWitnessReason,
  MigrationSelectionAuthority,
  MigrationDestinationIdentity,
  MigrationCanonicalDeltaEntry,
  MigrationCanonicalDelta,
  MigrationCensusVectorEntry,
  MigrationCensusVector,
  MigrationSchemaWitness,
  MigrationOpaqueEvidence,
  CreateMigrationOpaqueEvidenceInput,
  MigrationQuiescenceFence,
  MigrationIntraActivationWatermark,
  MigrationActivationEpoch,
  CreateMigrationActivationEpochInput,
  MigrationActivationAttempt,
  CreateMigrationActivationAttemptInput,
  MigrationActivationWitness,
  CreateMigrationActivationWitnessInput,
  ClassifyMigrationRollbackModeInput,
} from "./activation-witness.js";

// --- #624: verification report body, identity and mismatch vocabulary ------

export {
  MigrationVerificationReportError,
  MIGRATION_RECONCILIATION_DOMAIN_ORDER,
  MIGRATION_MISMATCH_CLASSES,
  MIGRATION_MISMATCH_CLASS_TRUNCATION_LIMIT,
  MIGRATION_PUBLIC_PROBE_ORDERING_SHA256,
  migrationReconciliationOutcomeDigest,
  createMigrationVerificationReportBody,
  createMigrationVerificationReport,
  parseMigrationVerificationReport,
} from "./verification-report.js";
export type {
  MigrationVerificationReportReason,
  MigrationReconciliationDomain,
  MigrationMismatchClass,
  MigrationClassCoverageEntry,
  MigrationClassCoverageVector,
  MigrationVerificationMismatch,
  MigrationVerificationMismatchTotal,
  MigrationVerificationSampleParameters,
  MigrationQueueClassificationWitness,
  MigrationSourceWitnessDigests,
  MigrationVerificationReportBody,
  CreateMigrationVerificationReportBodyInput,
  MigrationVerificationReport,
  CreateMigrationVerificationReportInput,
} from "./verification-report.js";

// --- #624: atomic private persistence for verification reports -------------

export {
  MigrationVerificationStoreError,
  MigrationVerificationReportStore,
  migrationVerificationReportFilename,
  parseMigrationVerificationReportFilename,
} from "./verification-store.js";
export type {
  MigrationVerificationStoreReason,
  MigrationVerificationPersistOutcome,
  MigrationVerificationStoreOptions,
} from "./verification-store.js";

// --- #624: the generation-verification driver -------------------------------
//
// verify-generation.ts also exports a wide internal surface (per-class
// reconciliation functions, the fenced-census reader, mismatch sorting and
// truncation helpers, and so on) that exists solely so its own test file
// can exercise each piece in isolation and demonstrate a red case before
// green. None of that is exported here: a test needing something not
// listed below is a signal that seam belongs somewhere else, not a reason
// to widen this list. Only the driver's actual entry point and its public
// input/output/error contract are curated surface.
//
// plan-v4's scope also names a second, read-only "inspect" entry point
// that never publishes -- inspectMigrationVerification, below. It shares
// computeVerificationReport with the publishing driver but has no
// reference anywhere in its own body to persistence or manifest-effect
// mutation, so it cannot publish structurally, not merely by choosing
// not to.
export {
  MigrationVerificationDriverError,
  inspectMigrationVerification,
  migrationVerificationEffectId,
  verifyMigrationGeneration,
} from "./verify-generation.js";
export type {
  MigrationVerificationDriverReason,
  VerifyMigrationGenerationInput,
  VerifyMigrationGenerationDependencies,
  VerifyMigrationGenerationResult,
} from "./verify-generation.js";
