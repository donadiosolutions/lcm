import { defineConfig } from "vitest/config";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sqliteRouteTests = ["test/daemon/routes/**/*.test.ts"];
const e2eTests = ["test/e2e/**/*.test.ts"];
const runtimeHomeSetup = ["test/setup/isolate-runtime-home.ts"];

export default defineConfig({
  cacheDir: join(tmpdir(), "vitest-lcm-cache"),
  test: {
    setupFiles: runtimeHomeSetup,
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".claude/**"],
    coverage: {
      include: ["bin/**/*.ts", "installer/**/*.ts", "src/**/*.ts"],
      thresholds: {
        lines: 84.54,
        branches: 81.08,
        "src/scrub.ts": { lines: 100, branches: 100 },
        "src/transcript.ts": { lines: 100, branches: 100 },
        "src/llm/process-utils.ts": { lines: 100, branches: 100 },
        "src/url-display.ts": { lines: 100, branches: 100 },
        "src/db/**/*.ts": { lines: 100, branches: 100 },
        "src/store/**/*.ts": { lines: 100, branches: 100 },
        "src/promotion/**/*.ts": { lines: 100, branches: 100 },
        "src/project-map.ts": { lines: 100, branches: 100 },
        "src/daemon/routes/describe.ts": { lines: 100, branches: 100 },
        "src/daemon/routes/expand.ts": { lines: 100, branches: 100 },
        "src/daemon/routes/grep.ts": { lines: 100, branches: 100 },
        "src/daemon/routes/ingest.ts": { lines: 100, branches: 100 },
        "src/daemon/routes/pool-stats.ts": { lines: 100, branches: 100 },
        "src/daemon/routes/promote-events.ts": { lines: 100, branches: 100 },
        "src/daemon/routes/promote.ts": { lines: 100, branches: 100 },
        "src/daemon/routes/recent.ts": { lines: 100, branches: 100 },
        "src/daemon/routes/review-stale.ts": { lines: 100, branches: 100 },
        "src/daemon/routes/search.ts": { lines: 100, branches: 100 },
        "src/daemon/routes/session-complete.ts": { lines: 100, branches: 100 },
        "src/daemon/routes/stats.ts": { lines: 100, branches: 100 },
        "src/daemon/routes/status.ts": { lines: 100, branches: 100 },
        "src/daemon/routes/store.ts": { lines: 100, branches: 100 },
        "installer/**/*.ts": { lines: 100, branches: 100 },
        "src/connectors/**/*.ts": { lines: 100, branches: 100 },
        "src/hooks/**/*.ts": { lines: 100, branches: 100 },
        "src/installer/**/*.ts": { lines: 100, branches: 100 },
        "src/llm/**/*.ts": { lines: 100, branches: 100 },
        "src/prompts/**/*.ts": { lines: 100, branches: 100 },
        "src/batch-compact.ts": { lines: 100, branches: 100 },
        "src/compaction.ts": { lines: 100, branches: 100 },
        "src/expansion.ts": { lines: 100, branches: 100 },
        "src/import-summary.ts": { lines: 100, branches: 100 },
        "src/import.ts": { lines: 100, branches: 100 },
        "src/large-files.ts": { lines: 100, branches: 100 },
        "src/retrieval.ts": { lines: 100, branches: 100 },
        "src/summarize.ts": { lines: 100, branches: 100 },
      },
    },
    projects: [
      {
        test: {
          name: "unit-parallel",
          setupFiles: runtimeHomeSetup,
          include: ["test/**/*.test.ts"],
          exclude: [...sqliteRouteTests, ...e2eTests, "node_modules/**", ".claude/**"],
          sequence: {
            groupOrder: 0,
          },
        },
      },
      {
        test: {
          name: "unit-sqlite-routes",
          setupFiles: runtimeHomeSetup,
          include: sqliteRouteTests,
          exclude: ["node_modules/**", ".claude/**"],
          // Route handler tests repeatedly open and migrate project SQLite DBs.
          // Keep this narrow group serial while the rest of the unit suite stays parallel.
          sequence: {
            groupOrder: 1,
          },
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "e2e",
          setupFiles: runtimeHomeSetup,
          include: e2eTests,
          exclude: ["node_modules/**", ".claude/**"],
          // E2E tests spin up real daemons backed by SQLite — must run
          // sequentially to avoid concurrent write conflicts.
          sequence: {
            groupOrder: 2,
          },
          fileParallelism: false,
        },
      },
    ],
  },
});
