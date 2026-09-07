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

describe("storage backend availability", () => {
  it("selects PostgreSQL after publication admission", () => {
    expect(selectStorageBackend({ backend: "postgresql", homeDir: "/synthetic/home" }))
      .toEqual({backend: "postgresql"});
  });
  it("keeps an explicit bounded refusal for operations awaiting PostgreSQL support", () => {
    expect(new StorageBackendUnavailableError("postgresql")).toMatchObject({
      name: "StorageBackendUnavailableError",
      message: "This operation is not available for the postgresql storage backend.",
    });
  });
});
