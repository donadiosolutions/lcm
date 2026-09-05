import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { defineConfig, type UserConfig } from "vitest/config";

const sqliteRouteTests = ["test/daemon/routes/**/*.test.ts"];
const worktreeReconciliationTests = ["test/worktree-reconciliation.test.ts"];
const serialSqliteTests = [...sqliteRouteTests, ...worktreeReconciliationTests];
const packageConfigTests = ["test/package-config.test.ts"];
const e2eTests = ["test/e2e/**/*.test.ts"];
const runtimeHomeSetup = ["test/setup/isolate-runtime-home.ts"];
const runtimeHomeGlobalSetup = ["test/setup/runtime-home-global.ts"];
const vitestRunRootCleanupRegistryKey = Symbol.for(
  "donadiosolutions/lcm:vitest-run-root-cleanups:v1",
);

type VitestRunRootCleanup = () => void;

type ProcessWithSymbolProperties = NodeJS.Process & {
  [key: symbol]: unknown;
};

export interface VitestRunRootDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly mkdtempSync?: typeof mkdtempSync;
  readonly mkdirSync?: typeof mkdirSync;
  readonly chmodSync?: typeof chmodSync;
  readonly lstatSync?: typeof lstatSync;
  readonly rmSync?: typeof rmSync;
  readonly registerProcessExit?: (listener: (code: number) => void) => void;
  readonly temporaryRoot?: () => string;
}

export interface VitestConfigurationResolverDependencies {
  readonly createRunRoot?: () => string;
}

export function drainVitestRunRootCleanups(
  registry: Set<VitestRunRootCleanup>,
): void {
  const cleanups = [...registry];
  registry.clear();
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      // Cleanup is best effort and must not interfere with process exit.
    }
  }
}

function registerVitestRunRootCleanup(cleanup: VitestRunRootCleanup): void {
  const processWithRegistry = process as ProcessWithSymbolProperties;
  const existingRegistry = processWithRegistry[vitestRunRootCleanupRegistryKey] as
    | Set<VitestRunRootCleanup>
    | undefined;
  if (existingRegistry !== undefined) {
    existingRegistry.add(cleanup);
    return;
  }

  const registry = new Set<VitestRunRootCleanup>();
  const drain = (): void => drainVitestRunRootCleanups(registry);
  try {
    process.once("exit", drain);
    processWithRegistry[vitestRunRootCleanupRegistryKey] = registry;
  } catch (error) {
    try {
      process.removeListener("exit", drain);
    } catch {
      // Preserve the original setup error if listener rollback itself fails.
    }
    throw error;
  }
  registry.add(cleanup);
}

function assertFreshExplicitRoot(
  root: string,
  createDirectory: typeof mkdirSync,
  inspectPath: typeof lstatSync,
): void {
  const parent = dirname(root);
  if (!basename(root)) {
    throw new Error("LCM_TEST_ARTIFACT_ROOT must name a fresh leaf");
  }
  const parentStats = inspectPath(parent);
  if (!parentStats.isDirectory()) {
    throw new Error("LCM_TEST_ARTIFACT_ROOT parent must be a directory");
  }
  try {
    inspectPath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    createDirectory(root, { mode: 0o700, recursive: false });
    return;
  }
  throw new Error("LCM_TEST_ARTIFACT_ROOT must not preexist");
}

export function createVitestRunRoot(
  dependencies: VitestRunRootDependencies = {},
): string {
  const environment = dependencies.environment ?? process.env;
  const createTemporaryDirectory = dependencies.mkdtempSync ?? mkdtempSync;
  const createDirectory = dependencies.mkdirSync ?? mkdirSync;
  const secureDirectory = dependencies.chmodSync ?? chmodSync;
  const inspectPath = dependencies.lstatSync ?? lstatSync;
  const removeDirectory = dependencies.rmSync ?? rmSync;
  const registerProcessExit = dependencies.registerProcessExit;
  const override = environment.LCM_TEST_ARTIFACT_ROOT;
  let root: string;

  if (override === undefined || override === "") {
    const temporaryRoot = dependencies.temporaryRoot ?? tmpdir;
    root = createTemporaryDirectory(join(temporaryRoot(), "lcm-vitest-run-"));
  } else {
    if (override.trim() !== override || override.trim() === "" || !isAbsolute(override)) {
      throw new Error("LCM_TEST_ARTIFACT_ROOT must be an absolute, unpadded path");
    }

    assertFreshExplicitRoot(override, createDirectory, inspectPath);
    root = override;
  }

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    try {
      removeDirectory(root, { recursive: true, force: true });
    } catch {
      // Cleanup is best effort and must not interfere with process exit.
    }
  };

  try {
    secureDirectory(root, 0o700);
    if (override === undefined || override === "") {
      if (registerProcessExit === undefined) {
        registerVitestRunRootCleanup(cleanup);
      } else {
        registerProcessExit(cleanup);
      }
    }
  } catch (error) {
    cleanup();
    throw error;
  }

  return root;
}

export function createVitestConfiguration(root: string): UserConfig {
  return {
    cacheDir: join(root, "cache"),
    test: {
      globalSetup: runtimeHomeGlobalSetup,
      setupFiles: runtimeHomeSetup,
      include: ["**/*.test.ts"],
      exclude: ["node_modules/**", ".claude/**"],
      pool: "forks",
      coverage: {
        include: ["bin/**/*.ts", "installer/**/*.ts", "src/**/*.ts"],
        reportsDirectory: join(root, "coverage"),
        thresholds: {
          statements: 100,
          lines: 100,
          branches: 100,
          functions: 100,
          perFile: true,
        },
      },
      outputFile: {
        junit: join(root, "test-report.junit.xml"),
      },
      projects: [
        {
          test: {
            name: "unit-parallel",
            pool: "forks",
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
            pool: "forks",
            globalSetup: runtimeHomeGlobalSetup,
            setupFiles: runtimeHomeSetup,
            include: packageConfigTests,
            exclude: ["node_modules/**", ".claude/**"],
            sequence: {
              groupOrder: 1,
            },
            // Package inventory tests run pnpm build and mutate dist. Keep them
            // out of the parallel unit pool so they cannot race other tests.
            fileParallelism: false,
          },
        },
        {
          test: {
            name: "unit-sqlite-routes",
            pool: "forks",
            globalSetup: runtimeHomeGlobalSetup,
            setupFiles: runtimeHomeSetup,
            include: serialSqliteTests,
            exclude: ["node_modules/**", ".claude/**"],
            sequence: {
              groupOrder: 2,
            },
            // Route handler and worktree reconciliation tests repeatedly open and migrate
            // project SQLite DBs. Keep this group serial and ordered after the parallel
            // unit pool so their real timeout assertions are not distorted by I/O contention.
            fileParallelism: false,
          },
        },
        {
          test: {
            name: "e2e",
            pool: "forks",
            globalSetup: runtimeHomeGlobalSetup,
            setupFiles: runtimeHomeSetup,
            include: e2eTests,
            exclude: ["node_modules/**", ".claude/**"],
            sequence: {
              groupOrder: 3,
            },
            // E2E tests spin up real daemons backed by SQLite — must run
            // sequentially to avoid concurrent write conflicts.
            fileParallelism: false,
          },
        },
      ],
    },
  };
}

export function createVitestConfigurationResolver(
  dependencies: VitestConfigurationResolverDependencies = {},
): () => UserConfig {
  const createRunRoot = dependencies.createRunRoot ?? (() => createVitestRunRoot());
  let configuration: UserConfig | undefined;
  return () => {
    configuration ??= createVitestConfiguration(createRunRoot());
    return configuration;
  };
}

export default defineConfig(createVitestConfigurationResolver());
