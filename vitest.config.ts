import { defineConfig } from "vitest/config";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sqliteRouteTests = ["test/daemon/routes/**/*.test.ts"];
const worktreeReconciliationTests = ["test/worktree-reconciliation.test.ts"];
const serialSqliteTests = [...sqliteRouteTests, ...worktreeReconciliationTests];
const packageConfigTests = ["test/package-config.test.ts"];
const e2eTests = ["test/e2e/**/*.test.ts"];
const runtimeHomeSetup = ["test/setup/isolate-runtime-home.ts"];
const runtimeHomeGlobalSetup = ["test/setup/runtime-home-global.ts"];

export default defineConfig({
  cacheDir: join(tmpdir(), "vitest-lcm-cache"),
  test: {
    globalSetup: runtimeHomeGlobalSetup,
    setupFiles: runtimeHomeSetup,
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".claude/**"],
    coverage: {
      include: ["bin/**/*.ts", "installer/**/*.ts", "src/**/*.ts"],
      thresholds: {
        statements: 100,
        lines: 100,
        branches: 100,
        functions: 100,
        perFile: true,
      },
    },
    projects: [
      {
        test: {
          name: "unit-parallel",
          globalSetup: runtimeHomeGlobalSetup,
          setupFiles: runtimeHomeSetup,
          include: ["test/**/*.test.ts"],
          exclude: [
            ...serialSqliteTests,
            ...packageConfigTests,
            ...e2eTests,
            "node_modules/**",
            ".claude/**",
          ],
          sequence: {
            groupOrder: 0,
          },
        },
      },
      {
        test: {
          name: "unit-package",
          globalSetup: runtimeHomeGlobalSetup,
          setupFiles: runtimeHomeSetup,
          include: packageConfigTests,
          exclude: ["node_modules/**", ".claude/**"],
          // Package inventory tests run npm build and mutate dist. Keep them
          // out of the parallel unit pool so they cannot race other tests.
          sequence: {
            groupOrder: 1,
          },
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "unit-sqlite-routes",
          globalSetup: runtimeHomeGlobalSetup,
          setupFiles: runtimeHomeSetup,
          include: serialSqliteTests,
          exclude: ["node_modules/**", ".claude/**"],
          // Route handler and worktree reconciliation tests repeatedly open and migrate
          // project SQLite DBs. Keep this group serial and ordered after the parallel
          // unit pool so their real timeout assertions are not distorted by I/O contention.
          sequence: {
            groupOrder: 2,
          },
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "e2e",
          globalSetup: runtimeHomeGlobalSetup,
          setupFiles: runtimeHomeSetup,
          include: e2eTests,
          exclude: ["node_modules/**", ".claude/**"],
          // E2E tests spin up real daemons backed by SQLite — must run
          // sequentially to avoid concurrent write conflicts.
          sequence: {
            groupOrder: 3,
          },
          fileParallelism: false,
        },
      },
    ],
  },
});
