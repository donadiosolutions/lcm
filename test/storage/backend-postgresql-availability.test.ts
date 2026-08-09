import { describe, expect, it, vi } from "vitest";

const assertBackendPublicationConsumerAccess = vi.hoisted(() => vi.fn());

vi.mock("../../src/storage/backend-publication.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/storage/backend-publication.js")>();
  return {
    ...actual,
    assertBackendPublicationConsumerAccess,
  };
});

import {
  selectStorageBackend,
  StorageBackendUnavailableError,
} from "../../src/storage/backend.js";

describe("storage backend staged availability", () => {
  it("reports the bounded PostgreSQL-unavailable diagnostic after publication admission", () => {
    expect(() => selectStorageBackend({ backend: "postgresql", homeDir: "/synthetic/home" }))
      .toThrowError(StorageBackendUnavailableError);
    try {
      selectStorageBackend({ backend: "postgresql", homeDir: "/synthetic/home" });
    } catch (error) {
      expect(error).toMatchObject({
        name: "StorageBackendUnavailableError",
        message: expect.stringContaining("use storage.backend \"sqlite\""),
      });
    }
  });
});
