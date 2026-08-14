import { describe, expect, it } from "vitest";
import {
  createMigrationManifest,
  MigrationManifestStore,
} from "../../src/migration/index.js";

describe("migration package surface", () => {
  it("exports the protocol and durable store through one discoverable module", () => {
    expect(createMigrationManifest).toBeTypeOf("function");
    expect(MigrationManifestStore).toBeTypeOf("function");
  });
});
