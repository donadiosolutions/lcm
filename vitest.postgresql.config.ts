import { defineConfig } from "vitest/config";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  cacheDir: join(tmpdir(), "vitest-lcm-postgresql-cache"),
  test: {
    include: ["test/postgresql/**/*.integration.ts"],
    exclude: process.env.LCM_TEST_POSTGRES_INNER_CI === "true"
      ? ["test/postgresql/signal.integration.ts"]
      : [],
    fileParallelism: true,
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
