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
});
