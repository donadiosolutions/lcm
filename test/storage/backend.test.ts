import { describe, expect, it } from "vitest";
import {
  selectStorageBackend,
  StorageBackendUnavailableError,
} from "../../src/storage/backend.js";

describe("storage backend selection", () => {
  it("selects SQLite", () => {
    expect(selectStorageBackend({ backend: "sqlite" })).toEqual({ backend: "sqlite" });
  });

  it("fails explicitly for PostgreSQL until repository support lands", () => {
    const config = {
      backend: "postgresql" as const,
      postgresql: {
        poolMax: 5,
        connectionTimeoutMs: 10_000,
        idleTimeoutMs: 30_000,
        statementTimeoutMs: 60_000,
        url: "postgresql://secret@db.example.com/lcm",
        caFile: "/tmp/ca.crt",
      },
    };
    expect(() => selectStorageBackend(config)).toThrow(StorageBackendUnavailableError);
    try {
      selectStorageBackend(config);
    } catch (error) {
      expect(error).toMatchObject({ name: "StorageBackendUnavailableError" });
      expect((error as Error).message).toContain("not available in this release");
      expect((error as Error).message).not.toContain("secret");
    }
  });
});
