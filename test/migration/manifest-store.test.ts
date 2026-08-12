import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  migrationManifestGenerationDirectory,
  migrationManifestHeadPath,
  migrationManifestLockPath,
  migrationManifestRevisionPath,
} from "../../src/migration/manifest-store.js";

const HASH = "a".repeat(64);

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
