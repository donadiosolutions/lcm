import { pathToFileURL } from "node:url";
import type { ResolvedStorageConfig } from "../../daemon/config.js";
import { packageAsset, packageRootFor } from "../../runtime-root.js";
import type { PostgreSqlMigrationResult, PostgreSqlQueryExecutor } from "./contracts.js";
import { PostgreSqlRuntime } from "./runtime.js";

type PostgreSqlMigrationRuntime = PostgreSqlQueryExecutor & {
  transaction<T>(
    callback: (transaction: PostgreSqlQueryExecutor) => Promise<T>,
    options: { domain: "factory"; operation: string; signal?: AbortSignal },
  ): Promise<T>;
  close(): Promise<void>;
};

export interface PostgreSqlProvisioningDependencies {
  readonly createRuntime: (
    settings: Extract<ResolvedStorageConfig, { backend: "postgresql" }>["postgresql"],
  ) => PostgreSqlMigrationRuntime;
  readonly runMigrations: (
    runtime: PostgreSqlMigrationRuntime,
  ) => Promise<PostgreSqlMigrationResult>;
}

const DEFAULT_DEPENDENCIES: PostgreSqlProvisioningDependencies = {
  createRuntime: (settings) => new PostgreSqlRuntime(settings),
  runMigrations: async (runtime) => {
    // Keep migration-only schema inventories out of the inert plugin CLI
    // bundle. The packaged dist module remains the sole executable source.
    const root = packageRootFor(import.meta.url, 4);
    const migrationsPath = packageAsset(
      import.meta.url,
      root,
      "dist/src/storage/postgresql/migrations.js",
      "src/storage/postgresql/migrations.ts",
    );
    const migrations = await import(pathToFileURL(migrationsPath).href) as typeof import("./migrations.js");
    return migrations.runPostgreSqlMigrations(runtime);
  },
};

/**
 * Apply the packaged, checksummed PostgreSQL schema as the configured
 * migration role. Runtime grants remain a separate administrator action.
 */
export async function provisionPostgreSql(
  config: ResolvedStorageConfig,
  dependencyOverrides: Partial<PostgreSqlProvisioningDependencies> = {},
): Promise<PostgreSqlMigrationResult> {
  if (config.backend !== "postgresql") {
    throw new Error(
      'PostgreSQL migration requires storage.backend "postgresql"; configure it before running `lcm postgres migrate`',
    );
  }
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const runtime = dependencies.createRuntime(config.postgresql);
  let result: PostgreSqlMigrationResult;
  try {
    result = await dependencies.runMigrations(runtime);
  } catch (error) {
    try {
      await runtime.close();
    } catch {
      // Preserve the actionable migration failure over a secondary close error.
    }
    throw error;
  }
  await runtime.close();
  return result;
}
