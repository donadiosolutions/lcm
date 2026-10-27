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

export {
  readBackendPublicationOperabilityFact,
  deriveRollbackPublicationId,
  deriveRollbackPrepareInputSha256,
  deriveRollbackReportId,
  deriveRollbackAuthorityArtifactId,
  writeRollbackReport,
  readRollbackReport,
  writeRollbackAuthorityArtifact,
  readRollbackAuthorityArtifact,
  runMigrationRollback,
  RollbackOrchestrationError,
} from "./rollback.js";
export type {
  MigrationSelectionBindingRecorder,
  MigrationWitnessBindingRecorder,
  RollbackAuthoritativeContextResolver,
  RollbackFencedSession,
  OpenRollbackFencedSession,
  RollbackReportBody,
  RollbackAuthorityArtifactBody,
  ComputeRollbackTerminalEvidenceInput,
  RollbackTerminalEvidenceComputer,
  RunMigrationRollbackDependencies,
  RunMigrationRollbackInput,
  RunMigrationRollbackOutcome,
  RollbackOrchestrationErrorReason,
} from "./rollback.js";

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

// --- #625: activation orchestrator building blocks --------------------------
//
// Phase-1 pieces of the activation orchestrator (plan-v6 G5, G6, G7 and the
// deterministic publicationId). The orchestrator itself (G1) is not here yet.

export {
  ActivationPublicationIdError,
  deriveActivationPublicationId,
} from "./activation-publication-id.js";

export {
  MigrationTargetHealthError,
  checkMigrationTargetHealth,
} from "./target-health.js";
export type {
  MigrationTargetHealthDependencies,
  MigrationTargetHealthErrorReason,
  MigrationTargetHealthInput,
  MigrationTargetHealthResult,
  MigrationTargetHealthRuntime,
  MigrationTargetHealthStatus,
  MigrationTargetUnhealthyReason,
  MigrationTargetUnresolvableReason,
} from "./target-health.js";

export {
  ActivationGenerationLinkConflictError,
  activationGenerationLinkPath,
  readActivationGenerationLink,
  recordActivationGenerationLink,
} from "./activation-artifact-store.js";
export type {
  ActivationGenerationLink,
  ActivationGenerationLinkReadResult,
  ActivationGenerationLinkRecordResult,
  ActivationGenerationLinkUnresolvableReason,
} from "./activation-artifact-store.js";

export {
  MigrationActivationReportError,
  createMigrationActivationReport,
  migrationActivationReportDirectory,
  migrationActivationReportPath,
  migrationActivationReportReference,
  migrationActivationReportStoreDirectory,
  parseMigrationActivationReport,
  persistMigrationActivationReport,
  readMigrationActivationReport,
} from "./activation-report.js";
export type {
  CreateMigrationActivationReportInput,
  MigrationActivationReport,
  MigrationActivationReportBody,
  MigrationActivationReportPersistResult,
  MigrationActivationReportReadResult,
  MigrationActivationReportReason,
  MigrationActivationReportStoreDependencies,
  MigrationActivationReportUnresolvableReason,
} from "./activation-report.js";

export {
  MIGRATION_PROJECT_MAP_WITNESS_DOMAIN,
  MigrationProjectMapWitnessError,
  computeMigrationProjectMapWitnessSha256,
  migrationProjectMapWitnessDigest,
} from "./project-map-witness.js";
export type {
  ComputeMigrationProjectMapWitnessDependencies,
  ComputeMigrationProjectMapWitnessInput,
  MigrationProjectMapDriftCause,
  MigrationProjectMapWitnessMode,
  MigrationProjectMapWitnessReason,
} from "./project-map-witness.js";

export {
  enumerateStoredDataProjectHashes,
  evaluateActivationSingleProjectCoverage,
} from "./activation-coverage.js";
export type {
  ActivationSingleProjectReason,
  ActivationSingleProjectVerdict,
  StoredDataProjectEnumeration,
  StoredDataProjectEnumerationReason,
} from "./activation-coverage.js";

export {
  MigrationCopyBindingReadError,
  readMigrationCopyBindingSha256,
} from "./copy-binding-reader.js";
export type {
  MigrationCopyBindingReadResult,
  MigrationCopyBindingUnresolvableReason,
  ReadMigrationCopyBindingInput,
} from "./copy-binding-reader.js";

// --- #625: the activation orchestrator (G1) ----------------------------------
//
// plan-v7.1: one entry point that activates or recovers one verified
// generation under the local append barrier, a non-predictive preview, and
// the production dependency builder, which wires the #626 evidence store,
// witness-binding resolver and census builders at exactly one point.

export {
  MIGRATION_ACTIVATION_LEASE_TTL_MS,
  MigrationActivationError,
  createMigrationActivationDependencies,
  previewMigrationActivation,
  readMigrationManifestRevision,
  runMigrationActivation,
} from "./activate-generation.js";
export type {
  MigrationActivationBindingSeam,
  MigrationActivationCensusSeam,
  MigrationActivationCoordinator,
  MigrationActivationCrashPoint,
  MigrationActivationDependencies,
  MigrationActivationEvidenceSeam,
  MigrationActivationIdentity,
  MigrationActivationInput,
  MigrationActivationInterruptionCause,
  MigrationActivationInterruptionStep,
  MigrationActivationOrdinaryRuntime,
  MigrationActivationOutcome,
  MigrationActivationPreview,
  MigrationActivationPreviewCheck,
  MigrationActivationRefusalReason,
  MigrationActivationRefusalStep,
  MigrationActivationResumePoint,
  MigrationActivationSnapshot,
  MigrationActivationTransferRuntime,
  MigrationActivationTriState,
} from "./activate-generation.js";
