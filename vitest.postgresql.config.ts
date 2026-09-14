import { defineConfig } from "vitest/config";
import { tmpdir } from "node:os";
import { join } from "node:path";

const POSTGRESQL_RUN_ID_PATTERN = /^[0-9a-f]{32}$/u;

export function postgresqlVitestCacheDir(
  environment: NodeJS.ProcessEnv = process.env,
  processId = process.pid,
): string {
  const runId = environment.LCM_TEST_POSTGRES_RUN_ID;
  const namespace = runId && POSTGRESQL_RUN_ID_PATTERN.test(runId)
    ? runId
    : `process-${processId}`;
  return join(tmpdir(), "vitest-lcm-postgresql-cache", namespace);
}

export function createPostgresqlVitestConfiguration(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
) {
  // PostgreSQL integration tests also run from local agent worktrees. Keep their
  // fork pool within the local allocation while retaining the CI concurrency.
  const maxWorkers = environment.CI === "true" || environment.CI === "1" ? 4 : 1;
  return {
    cacheDir: postgresqlVitestCacheDir(environment),
    test: {
      pool: "forks",
      globalSetup: ["test/setup/runtime-home-global.ts"],
      setupFiles: ["test/setup/isolate-runtime-home.ts"],
      include: environment.LCM_TEST_POSTGRES_FORK_PROBE === "true"
        ? ["test/postgresql/fixtures/persistent-worker.integration.ts"]
        : ["test/postgresql/**/*.integration.ts"],
      exclude: environment.LCM_TEST_POSTGRES_FORK_PROBE === "true"
        ? []
        : [
          "test/postgresql/fixtures/persistent-worker.integration.ts",
          ...(environment.LCM_TEST_POSTGRES_INNER_CI === "true"
            ? ["test/postgresql/signal.integration.ts"]
            : []),
        ],
      fileParallelism: true,
      maxWorkers,
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  };
}

export default defineConfig(createPostgresqlVitestConfiguration());
