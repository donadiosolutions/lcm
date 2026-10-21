import { expect, it } from "vitest";
import { buildVerificationInputs } from "../../src/migration/cli-verify.js";
import { createMigrationManifest } from "../../src/migration/protocol.js";

it("refuses a manifest that never recorded the destination cluster identifier, without inventing one", async () => {
  const manifest = createMigrationManifest({
    generationId: "member-generation-1",
    source: { version: 1, backend: "sqlite", identitySha256: "1".repeat(64), schemaSha256: "2".repeat(64), contentSha256: "3".repeat(64), capturedAt: "2026-08-12T12:00:00.000Z" },
    destination: { version: 1, backend: "postgresql", identitySha256: "4".repeat(64), schemaSha256: "5".repeat(64), contentSha256: "6".repeat(64), capturedAt: "2026-08-12T12:00:00.000Z" },
    parentGenerationId: null, preservedSourceGenerationId: "member-generation-1", createdAt: "2026-08-12T12:00:00.000Z",
  });
  expect(await buildVerificationInputs({
    homeDir: "/unused", generationId: "member-generation-1", manifest, ops: undefined,
    destination: { settings: {} as never, expectedOwner: "owner", expectedIdentity: {} as never },
  })).toEqual({ status: "refuse", reason: "verify-destination-drift", generationId: "member-generation-1", evidence: "system-identifier-absent" });
});

