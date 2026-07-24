import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedStorageConfig } from "../../src/daemon/config.js";
import { provisionPostgreSql } from "../../src/storage/postgresql/provisioning.js";

const defaults = vi.hoisted(() => ({
  settings: [] as unknown[],
  close: vi.fn(async () => undefined),
  runMigrations: vi.fn(async () => ({
    applied: ["0001_migration_ledger"],
    current: ["0001_migration_ledger"],
  })),
}));

vi.mock("../../src/storage/postgresql/runtime.js", () => ({
  PostgreSqlRuntime: class {
    constructor(settings: unknown) {
      defaults.settings.push(settings);
    }
    close = defaults.close;
  },
}));

vi.mock("../../src/storage/postgresql/migrations.js", () => ({
  runPostgreSqlMigrations: defaults.runMigrations,
}));

const postgresql = {
  backend: "postgresql",
  postgresql: {
    url: "postgresql://user:secret@example.test/lcm",
    caFile: "/secure/ca.pem",
    poolMax: 5,
    connectionTimeoutMs: 10_000,
    idleTimeoutMs: 30_000,
    statementTimeoutMs: 60_000,
  },
} satisfies ResolvedStorageConfig;

describe("provisionPostgreSql", () => {
  const close = vi.fn(async () => undefined);
  const runtime = { close } as never;
  const createRuntime = vi.fn(() => runtime);
  const runMigrations = vi.fn(async () => ({
    applied: ["0001_migration_ledger"],
    current: ["0001_migration_ledger"],
  }));

  beforeEach(() => {
    vi.clearAllMocks();
    defaults.settings = [];
  });

  it("rejects SQLite before opening a PostgreSQL runtime", async () => {
    await expect(provisionPostgreSql(
      { backend: "sqlite" },
      { createRuntime, runMigrations },
    )).rejects.toThrow('requires storage.backend "postgresql"');
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("runs packaged migrations with the configured runtime and closes it", async () => {
    await expect(provisionPostgreSql(
      postgresql,
      { createRuntime, runMigrations },
    )).resolves.toEqual({
      applied: ["0001_migration_ledger"],
      current: ["0001_migration_ledger"],
    });
    expect(createRuntime).toHaveBeenCalledWith(postgresql.postgresql);
    expect(runMigrations).toHaveBeenCalledWith(runtime);
    expect(close).toHaveBeenCalledOnce();
  });

  it("loads the packaged migration runner through the production dependencies", async () => {
    await expect(provisionPostgreSql(postgresql)).resolves.toEqual({
      applied: ["0001_migration_ledger"],
      current: ["0001_migration_ledger"],
    });
    expect(defaults.settings).toEqual([postgresql.postgresql]);
    expect(defaults.runMigrations).toHaveBeenCalledOnce();
    expect(defaults.close).toHaveBeenCalledOnce();
  });

  it("preserves a migration failure when close also fails", async () => {
    const migrationFailure = new Error("migration failed");
    runMigrations.mockRejectedValueOnce(migrationFailure);
    close.mockRejectedValueOnce(new Error("close failed"));

    await expect(provisionPostgreSql(
      postgresql,
      { createRuntime, runMigrations },
    )).rejects.toBe(migrationFailure);
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports a close failure after successful migration", async () => {
    const closeFailure = new Error("close failed");
    close.mockRejectedValueOnce(closeFailure);

    await expect(provisionPostgreSql(
      postgresql,
      { createRuntime, runMigrations },
    )).rejects.toBe(closeFailure);
  });
});
