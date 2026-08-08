import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  selectStorageBackend,
  selectStorageBackendForConfig,
} from "../../src/storage/backend.js";
import { BackendPublicationJournalError } from "../../src/storage/backend-publication.js";

describe("storage backend selection", () => {
  it("selects SQLite", () => {
    expect(selectStorageBackend({ backend: "sqlite" })).toEqual({ backend: "sqlite" });
  });

  it("binds direct selection to the canonical config publication home", () => {
    expect(() => selectStorageBackendForConfig("/tmp/config.json", { backend: "sqlite" }))
      .toThrowError(expect.objectContaining({
        name: "BackendPublicationJournalError",
        reason: "unsafe-storage",
      }));

    const home = mkdtempSync(join(tmpdir(), "lcm-storage-selection-"));
    try {
      mkdirSync(join(home, ".lcm"), { mode: 0o700 });
      expect(selectStorageBackendForConfig(
        join(home, ".lcm", "config.json"),
        { backend: "sqlite" },
      )).toEqual({ backend: "sqlite" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails closed for PostgreSQL without completed publication evidence", () => {
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
    expect(() => selectStorageBackend(config)).toThrow(BackendPublicationJournalError);
    try {
      selectStorageBackend(config);
    } catch (error) {
      expect(error).toMatchObject({
        name: "BackendPublicationJournalError",
        reason: "publication-evidence-missing",
      });
      expect((error as Error).message).not.toContain("secret");
    }
  });
});
