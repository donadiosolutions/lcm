import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  selectStorageBackend,
} from "../../src/storage/backend.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lcm-storage-backend-"));
  vi.stubEnv("HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("storage backend selection", () => {
  it("selects SQLite", () => {
    expect(selectStorageBackend({ backend: "sqlite" })).toEqual({ backend: "sqlite" });
  });

  it("treats legacy no-journal PostgreSQL selection as untrusted", () => {
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
    expect(() => selectStorageBackend(config)).toThrowError(
      expect.objectContaining({ reason: "publication-evidence-missing" }),
    );
    try {
      selectStorageBackend(config);
    } catch (error) {
      expect(error).toMatchObject({
        name: "BackendPublicationJournalError",
        reason: "publication-evidence-missing",
      });
      expect((error as Error).message).toContain("publication evidence");
      expect((error as Error).message).not.toContain("secret");
    }
  });
});
