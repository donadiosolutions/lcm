import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedStorageConfig } from "../src/daemon/config.js";

const state = vi.hoisted(() => ({
  health: vi.fn(),
  close: vi.fn(async () => undefined),
  settings: [] as unknown[],
}));

vi.mock("../src/storage/postgresql/runtime.js", () => ({
  PostgreSqlRuntime: class {
    constructor(settings: unknown) {
      state.settings.push(settings);
    }

    health = state.health;
    close = state.close;
  },
}));

const {
  openPostgreSqlIdentitySession,
  RemoteIdentityConfigurationError,
} = await import("../src/identity-service.js");

const postgresql = {
  backend: "postgresql",
  postgresql: { url: "postgresql://example.test/lcm", caFile: "/ca.pem" },
} as unknown as ResolvedStorageConfig;

describe("openPostgreSqlIdentitySession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.settings = [];
  });

  it("opens and closes a healthy identity repository session", async () => {
    state.health.mockResolvedValue({ status: "healthy" });
    const session = await openPostgreSqlIdentitySession(postgresql);

    expect(state.settings).toEqual([(postgresql as Extract<
      ResolvedStorageConfig,
      { backend: "postgresql" }
    >).postgresql]);
    expect(session.repository).toBeDefined();
    await session.close();
    expect(state.close).toHaveBeenCalledOnce();
  });

  it("rejects SQLite before constructing a runtime", async () => {
    await expect(openPostgreSqlIdentitySession({ backend: "sqlite" }))
      .rejects.toBeInstanceOf(RemoteIdentityConfigurationError);
    expect(state.settings).toEqual([]);
  });

  it("closes and preserves an explicit unhealthy error", async () => {
    const failure = new Error("database unavailable");
    state.health.mockResolvedValue({ status: "unavailable", error: failure });

    await expect(openPostgreSqlIdentitySession(postgresql)).rejects.toBe(failure);
    expect(state.close).toHaveBeenCalledOnce();
  });

  it("closes and synthesizes an error when unhealthy health has no error", async () => {
    state.health.mockResolvedValue({ status: "degraded" });

    await expect(openPostgreSqlIdentitySession(postgresql))
      .rejects.toThrow("PostgreSQL identity storage is unavailable");
    expect(state.close).toHaveBeenCalledOnce();
  });

  it("closes when the health probe throws", async () => {
    state.health.mockRejectedValue(new Error("probe failed"));

    await expect(openPostgreSqlIdentitySession(postgresql)).rejects.toThrow("probe failed");
    expect(state.close).toHaveBeenCalledOnce();
  });
});
