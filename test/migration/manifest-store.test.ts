import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMigrationManifestHead,
  migrationManifestGenerationDirectory,
  migrationManifestHeadContent,
  migrationManifestHeadPath,
  migrationManifestLockPath,
  migrationManifestRevisionPath,
  parseMigrationManifestHeadContent,
} from "../../src/migration/manifest-store.js";
import { MigrationProtocolError } from "../../src/migration/protocol.js";

const HASH = "a".repeat(64);
const UPDATED_AT = "2026-08-12T12:00:00.000Z";

function expectProtocolReason(callback: () => unknown, reason: MigrationProtocolError["reason"]): void {
  try {
    callback();
    throw new Error("expected MigrationProtocolError");
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationProtocolError);
    expect((error as MigrationProtocolError).reason).toBe(reason);
  }
}

describe("migration manifest store layout", () => {
  it("derives the home lock, generation, head, and immutable revision paths", () => {
    const home = "/tmp/lcm-migration-home";
    const generation = join(home, ".lcm", "migrations", "generation-1");

    expect(migrationManifestLockPath(home)).toBe(join(home, ".lcm.migration-manifest.lock"));
    expect(migrationManifestGenerationDirectory("generation-1", home)).toBe(generation);
    expect(migrationManifestHeadPath("generation-1", home)).toBe(join(generation, "head.json"));
    expect(migrationManifestRevisionPath({
      generationId: "generation-1",
      revision: 42,
      checksumSha256: HASH,
    }, home)).toBe(join(generation, "revisions", "0000000000000042", `${HASH}.json`));
    expect(migrationManifestLockPath()).toBe(join(resolve(homedir()), ".lcm.migration-manifest.lock"));
    expect(migrationManifestGenerationDirectory("generation-1"))
      .toBe(join(resolve(homedir()), ".lcm", "migrations", "generation-1"));
  });

  it("rejects unsafe path identities before deriving storage paths", () => {
    for (const generationId of ["", "../escape", "x".repeat(129), 1 as never]) {
      expect(() => migrationManifestGenerationDirectory(generationId, "/tmp/home"))
        .toThrow("generation");
    }
    for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => migrationManifestRevisionPath({
        generationId: "generation-1",
        revision,
        checksumSha256: HASH,
      }, "/tmp/home")).toThrow("revision");
    }
    expect(() => migrationManifestRevisionPath({
      generationId: "generation-1",
      revision: 0,
      checksumSha256: "A".repeat(64),
    }, "/tmp/home")).toThrow("checksum");
  });
});

describe("migration manifest head codec", () => {
  it("seals and parses an exact canonical ASCII head", () => {
    const payload = `{"generationId":"generation-1","manifestSha256":"${HASH}","revision":42,"revisionFilename":"${HASH}.json","updatedAt":"${UPDATED_AT}","version":1}`;
    const checksumSha256 = createHash("sha256").update(payload, "utf8").digest("hex");
    const expectedContent = `{"checksumSha256":"${checksumSha256}","generationId":"generation-1","manifestSha256":"${HASH}","revision":42,"revisionFilename":"${HASH}.json","updatedAt":"${UPDATED_AT}","version":1}\n`;

    const head = createMigrationManifestHead({
      generationId: "generation-1",
      revision: 42,
      manifestSha256: HASH,
      updatedAt: UPDATED_AT,
    });
    expect(head).toEqual({
      version: 1,
      generationId: "generation-1",
      revision: 42,
      revisionFilename: `${HASH}.json`,
      manifestSha256: HASH,
      updatedAt: UPDATED_AT,
      checksumSha256,
    });
    expect(Object.isFrozen(head)).toBe(true);
    expect(migrationManifestHeadContent(head)).toBe(expectedContent);
    expect(parseMigrationManifestHeadContent(expectedContent)).toEqual(head);
    expect(Object.isFrozen(parseMigrationManifestHeadContent(expectedContent))).toBe(true);
  });

  it("rejects non-ASCII, noncanonical, malformed, and checksum-drifted heads", () => {
    const head = createMigrationManifestHead({
      generationId: "generation-1",
      revision: 0,
      manifestSha256: HASH,
      updatedAt: UPDATED_AT,
    });
    const content = migrationManifestHeadContent(head);
    expectProtocolReason(() => parseMigrationManifestHeadContent(`é${content}`), "malformed-manifest");
    expectProtocolReason(() => parseMigrationManifestHeadContent(content.slice(0, -1)), "malformed-manifest");
    expectProtocolReason(() => parseMigrationManifestHeadContent(`${content}\n`), "malformed-manifest");
    expectProtocolReason(() => parseMigrationManifestHeadContent("not-json\n"), "malformed-manifest");
    expectProtocolReason(() => parseMigrationManifestHeadContent(content.replace('"version":1', '"extra":true,"version":1')), "malformed-manifest");
    expectProtocolReason(() => parseMigrationManifestHeadContent(content.replace(head.checksumSha256, "0".repeat(64))), "checksum-mismatch");
    expectProtocolReason(() => parseMigrationManifestHeadContent(content.replace(`${HASH}.json`, `${"b".repeat(64)}.json`)), "malformed-manifest");
    expectProtocolReason(() => parseMigrationManifestHeadContent("null\n"), "malformed-manifest");
    expectProtocolReason(() => parseMigrationManifestHeadContent("[]\n"), "malformed-manifest");

    const parsed = JSON.parse(content) as Record<string, unknown>;
    for (const [field, value] of [
      ["version", 2],
      ["generationId", 1],
      ["revision", -1],
      ["manifestSha256", "A".repeat(64)],
      ["revisionFilename", 1],
      ["updatedAt", "yesterday"],
      ["checksumSha256", "A".repeat(64)],
    ] as const) {
      expectProtocolReason(
        () => parseMigrationManifestHeadContent(`${JSON.stringify({ ...parsed, [field]: value })}\n`),
        "malformed-manifest",
      );
    }
    expectProtocolReason(
      () => parseMigrationManifestHeadContent(`${JSON.stringify({ ...parsed, generationId: "../escape" })}\n`),
      "malformed-manifest",
    );
    expectProtocolReason(
      () => parseMigrationManifestHeadContent(` ${content}`),
      "malformed-manifest",
    );

    for (const input of [
      null,
      { generationId: "generation-1", revision: -1, manifestSha256: HASH, updatedAt: UPDATED_AT },
      { generationId: "generation-1", revision: 0, manifestSha256: "A".repeat(64), updatedAt: UPDATED_AT },
      { generationId: "generation-1", revision: 0, manifestSha256: HASH, updatedAt: "yesterday" },
    ]) {
      expectProtocolReason(() => createMigrationManifestHead(input as never), "invalid-input");
    }
    expectProtocolReason(
      () => migrationManifestHeadContent({ ...head, version: 2 as never }),
      "malformed-manifest",
    );
  });
});
