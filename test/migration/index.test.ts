import { describe, expect, it } from "vitest";
import {
  authenticateSqliteMigrationSource,
  captureAuthenticatedSqliteMigrationSource,
  classifyImmutableSqliteSnapshot,
  createMigrationManifest,
  dryRunAuthenticatedSqliteMigrationSource,
  inspectImmutableSqliteSnapshot,
  MigrationManifestStore,
  prepareSqliteMigrationEnrollment,
  migrationWitnessSha256,
  parseMigrationActivationWitness,
  createMigrationVerificationReport,
  parseMigrationVerificationReport,
  MigrationVerificationReportStore,
  migrationVerificationReportFilename,
  verifyMigrationGeneration,
  inspectMigrationVerification,
  migrationVerificationEffectId,
  MigrationVerificationDriverError,
  deriveActivationPublicationId,
  recordActivationGenerationLink,
  readActivationGenerationLink,
  checkMigrationTargetHealth,
  createMigrationActivationReport,
  migrationActivationReportReference,
  persistMigrationActivationReport,
  readMigrationActivationReport,
  MigrationActivationError,
  createMigrationActivationDependencies,
  previewMigrationActivation,
  readMigrationManifestRevision,
  runMigrationActivation,
} from "../../src/migration/index.js";

describe("migration package surface", () => {
  it("exports the protocol and durable store through one discoverable module", () => {
    expect(createMigrationManifest).toBeTypeOf("function");
    expect(MigrationManifestStore).toBeTypeOf("function");
    expect(authenticateSqliteMigrationSource).toBeTypeOf("function");
    expect(captureAuthenticatedSqliteMigrationSource).toBeTypeOf("function");
    expect(classifyImmutableSqliteSnapshot).toBeTypeOf("function");
    expect(dryRunAuthenticatedSqliteMigrationSource).toBeTypeOf("function");
    expect(inspectImmutableSqliteSnapshot).toBeTypeOf("function");
    expect(prepareSqliteMigrationEnrollment).toBeTypeOf("function");
  });

  it("exports #624's curated verification surface: schema, report, store and driver", () => {
    expect(migrationWitnessSha256).toBeTypeOf("function");
    expect(parseMigrationActivationWitness).toBeTypeOf("function");
    expect(createMigrationVerificationReport).toBeTypeOf("function");
    expect(parseMigrationVerificationReport).toBeTypeOf("function");
    expect(MigrationVerificationReportStore).toBeTypeOf("function");
    expect(migrationVerificationReportFilename).toBeTypeOf("function");
    expect(verifyMigrationGeneration).toBeTypeOf("function");
    expect(inspectMigrationVerification).toBeTypeOf("function");
    expect(migrationVerificationEffectId).toBeTypeOf("function");
    expect(MigrationVerificationDriverError).toBeTypeOf("function");
  });

  it("exports #625's phase-1 activation building blocks: publicationId, generation link, target health and report", () => {
    expect(deriveActivationPublicationId).toBeTypeOf("function");
    expect(recordActivationGenerationLink).toBeTypeOf("function");
    expect(readActivationGenerationLink).toBeTypeOf("function");
    expect(checkMigrationTargetHealth).toBeTypeOf("function");
    expect(createMigrationActivationReport).toBeTypeOf("function");
    expect(migrationActivationReportReference).toBeTypeOf("function");
    expect(persistMigrationActivationReport).toBeTypeOf("function");
    expect(readMigrationActivationReport).toBeTypeOf("function");
  });

  it("exports #625's activation orchestrator: entry point, preview and dependency builder", () => {
    expect(runMigrationActivation).toBeTypeOf("function");
    expect(previewMigrationActivation).toBeTypeOf("function");
    expect(createMigrationActivationDependencies).toBeTypeOf("function");
    expect(readMigrationManifestRevision).toBeTypeOf("function");
    expect(MigrationActivationError).toBeTypeOf("function");
  });
});
