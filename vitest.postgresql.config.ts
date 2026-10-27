import { defineConfig } from "vitest/config";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

const POSTGRESQL_RUN_ID_PATTERN = /^[0-9a-f]{32}$/u;
const CENSUS_COST_TEST = "test/postgresql/migration-verification-census-cost.integration.ts";
const CUTOVER_REHEARSAL_TEST = "test/postgresql/cutover-rehearsal.integration.ts";

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
  cpuCount: () => number = availableParallelism,
) {
  // PostgreSQL integration tests also run from local agent worktrees. Keep their
  // fork pool within the local allocation; CI sizes the pool from the runner.
  const maxWorkers = environment.CI === "true" || environment.CI === "1" ? Math.max(1, cpuCount()) : 1;
  const forkProbe = environment.LCM_TEST_POSTGRES_FORK_PROBE === "true";
  // The census-cost measurement is opt-in: it is a long-running measurement,
  // not a correctness check, so only the dedicated script includes it.
  const censusCost = !forkProbe && environment.LCM_TEST_POSTGRES_CENSUS_COST === "true";
  // The full cutover rehearsal is opt-in as well: the default run still includes the same file,
  // which then generates only its small rows; the dedicated script selects the file alone and
  // every manifest row.
  const cutoverRehearsal = !forkProbe && environment.LCM_TEST_POSTGRES_CUTOVER_REHEARSAL === "true";
  if (censusCost && cutoverRehearsal) {
    throw new Error("The census-cost and cutover-rehearsal profiles are mutually exclusive");
  }
  return {
    cacheDir: postgresqlVitestCacheDir(environment),
    test: {
      pool: "forks",
      globalSetup: ["test/setup/runtime-home-global.ts"],
      setupFiles: ["test/setup/isolate-runtime-home.ts"],
      include: forkProbe
        ? ["test/postgresql/fixtures/persistent-worker.integration.ts"]
        : censusCost
          ? [CENSUS_COST_TEST]
          : cutoverRehearsal
            ? [CUTOVER_REHEARSAL_TEST]
            : ["test/postgresql/**/*.integration.ts"],
      exclude: forkProbe || censusCost || cutoverRehearsal
        ? []
        : [
          "test/postgresql/fixtures/persistent-worker.integration.ts",
          CENSUS_COST_TEST,
          ...(environment.LCM_TEST_POSTGRES_INNER_CI === "true"
            ? ["test/postgresql/signal.integration.ts"]
            : []),
        ],
      fileParallelism: true,
      maxWorkers,
      testTimeout: 30_000,
      hookTimeout: 30_000,
      // The harness fails closed when a child stream exceeds its 64 KiB capture cap, even for a
      // green run. The default reporter lists every passing test that runs longer than this
      // threshold (300 ms), which is nearly all of the integration tests and about 49 KB of the
      // output. Raising it drops those lines from passing files; every file line with its test
      // count and duration, every failure, and the run summary stay.
      slowTestThreshold: 600_000,
    },
  };
}

export default defineConfig(createPostgresqlVitestConfiguration());
