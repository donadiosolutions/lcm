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
});
