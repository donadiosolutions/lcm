import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/storage/backend-publication.js", () => ({
  assertBackendPublicationConsumerAccess: vi.fn(),
  withBackendPublicationConsumerLock: (
    _homeDir: string | undefined,
    operation: () => unknown,
  ): unknown => operation(),
}));

import { selectStorageBackend } from "../../src/storage/backend.js";

describe("storage backend implementation selection", () => {
  it("rejects an admitted PostgreSQL selection until its repository factory lands", () => {
    expect(() => selectStorageBackend({ backend: "postgresql" }))
      .toThrow("postgresql storage backend is not available");
  });
});
