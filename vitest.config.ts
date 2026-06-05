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
