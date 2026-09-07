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

export default defineConfig({
  cacheDir: postgresqlVitestCacheDir(),
  test: {
    pool: "forks",
    globalSetup: ["test/setup/runtime-home-global.ts"],
    setupFiles: ["test/setup/isolate-runtime-home.ts"],
    include: process.env.LCM_TEST_POSTGRES_FORK_PROBE === "true"
      ? ["test/postgresql/fixtures/persistent-worker.integration.ts"]
      : ["test/postgresql/**/*.integration.ts"],
    exclude: process.env.LCM_TEST_POSTGRES_FORK_PROBE === "true"
      ? []
      : [
        "test/postgresql/fixtures/persistent-worker.integration.ts",
        ...(process.env.LCM_TEST_POSTGRES_INNER_CI === "true"
          ? ["test/postgresql/signal.integration.ts"]
          : []),
      ],
    fileParallelism: true,
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
