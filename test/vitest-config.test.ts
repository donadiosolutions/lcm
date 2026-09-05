import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import packageJson from "../package.json";
import {
  createVitestConfiguration,
  createVitestConfigurationResolver,
  createVitestRunRoot,
  drainVitestRunRootCleanups,
} from "../vitest.config";

interface ChildDefaultRootResult {
  readonly before: number;
  readonly after: number;
  readonly count: number;
  readonly roots: string[];
  readonly warningNames: string[];
  readonly allRootsExist: boolean;
}

function runDefaultRootChild(
  parent: string,
  configPath: string,
): ChildDefaultRootResult {
  const scriptPath = join(parent, "default-root-child.mts");
  const resultPath = join(parent, "default-root-result.json");
  writeFileSync(scriptPath, `
import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const configPath = process.argv[2];
const resultPath = process.argv[3];
const count = Math.max(12, EventEmitter.defaultMaxListeners + 2);
const warnings = [];
const before = process.listenerCount("exit");
process.on("warning", (warning) => {
  warnings.push(warning.name + "|" + warning.message);
});
const roots = [];
for (let index = 0; index < count; index += 1) {
  const moduleUrl = pathToFileURL(configPath).href + "?fresh=" + index;
  const module = await import(moduleUrl);
  if (typeof module.default !== "function") {
    throw new Error("default export must be a resolver function");
  }
  const configuration = module.default();
  if (typeof configuration?.cacheDir !== "string") {
    throw new Error("resolver must return a config with a cache directory");
  }
  roots.push(dirname(configuration.cacheDir));
}
const after = process.listenerCount("exit");
await new Promise((resolve) => setImmediate(resolve));
writeFileSync(resultPath, JSON.stringify({
  before,
  after,
  count,
  roots,
  warningNames: warnings,
  allRootsExist: roots.every((root) => existsSync(root)),
}));
`, { mode: 0o600 });

  const childEnvironment = { ...process.env };
  delete childEnvironment.LCM_TEST_ARTIFACT_ROOT;
  childEnvironment.TMPDIR = parent;
  execFileSync(process.execPath, ["--experimental-strip-types", scriptPath, configPath, resultPath], {
    cwd: dirname(configPath),
    env: childEnvironment,
    stdio: "ignore",
  });
  return JSON.parse(readFileSync(resultPath, "utf8")) as ChildDefaultRootResult;
}

interface ChildExplicitRootResult {
  readonly before: number;
  readonly after: number;
  readonly root: string;
}

function runExplicitRootChild(
  parent: string,
  configPath: string,
  root: string,
): ChildExplicitRootResult {
  const scriptPath = join(parent, "explicit-root-child.mts");
  const resultPath = join(parent, "explicit-root-result.json");
  writeFileSync(scriptPath, `
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const configPath = process.argv[2];
const resultPath = process.argv[3];
const root = process.argv[4];
const before = process.listenerCount("exit");
const module = await import(pathToFileURL(configPath).href + "?fresh=explicit");
if (typeof module.default !== "function") {
  throw new Error("default export must be a resolver function");
}
const resolved = module.default();
if (resolved.test?.outputFile?.junit !== root + "/test-report.junit.xml") {
  throw new Error("resolver did not use the explicit root");
}
writeFileSync(root + "/sentinel", "keep");
const after = process.listenerCount("exit");
writeFileSync(resultPath, JSON.stringify({ before, after, root }));
`, { mode: 0o600 });

  const childEnvironment = { ...process.env, LCM_TEST_ARTIFACT_ROOT: root, TMPDIR: parent };
  execFileSync(process.execPath, ["--experimental-strip-types", scriptPath, configPath, resultPath, root], {
    cwd: dirname(configPath),
    env: childEnvironment,
    stdio: "ignore",
  });
  return JSON.parse(readFileSync(resultPath, "utf8")) as ChildExplicitRootResult;
}

describe("Vitest artifact-root configuration", () => {
  it("constructs a lazy resolver that creates one root and returns one config", () => {
    const createRunRoot = vi.fn(() => "/tmp/lcm-vitest-run-lazy");
    const resolver = createVitestConfigurationResolver({ createRunRoot });

    expect(createRunRoot).not.toHaveBeenCalled();

    const first = resolver();
    const second = resolver();

    expect(createRunRoot).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first.cacheDir).toBe("/tmp/lcm-vitest-run-lazy/cache");
    expect(first.test?.coverage?.reportsDirectory).toBe(
      "/tmp/lcm-vitest-run-lazy/coverage",
    );
    expect(first.test?.outputFile).toEqual({
      junit: "/tmp/lcm-vitest-run-lazy/test-report.junit.xml",
    });
  });

  it.each([
    ["unset", undefined],
    ["exactly empty", ""],
  ])("uses mkdtemp under tmpdir for a %s artifact-root override", (_label, override) => {
    const roots = [
      "/tmp/lcm-vitest-run-first",
      "/tmp/lcm-vitest-run-second",
    ];
    const createTemporaryDirectory = vi.fn(() => roots.shift()!);
    const secureDirectory = vi.fn();
    const environment = override === undefined
      ? {}
      : { LCM_TEST_ARTIFACT_ROOT: override };

    const first = createVitestRunRoot({
      environment,
      mkdtempSync: createTemporaryDirectory,
      chmodSync: secureDirectory,
      temporaryRoot: () => "/tmp",
      registerProcessExit: vi.fn(),
    });
    const second = createVitestRunRoot({
      environment,
      mkdtempSync: createTemporaryDirectory,
      chmodSync: secureDirectory,
      temporaryRoot: () => "/tmp",
      registerProcessExit: vi.fn(),
    });

    expect(createTemporaryDirectory).toHaveBeenNthCalledWith(
      1,
      join("/tmp", "lcm-vitest-run-"),
    );
    expect(createTemporaryDirectory).toHaveBeenNthCalledWith(
      2,
      join("/tmp", "lcm-vitest-run-"),
    );
    expect(first).not.toBe(second);
    expect(secureDirectory).toHaveBeenNthCalledWith(1, first, 0o700);
    expect(secureDirectory).toHaveBeenNthCalledWith(2, second, 0o700);
  });

  it("creates an explicit absolute fresh root exclusively and secures it", () => {
    const parent = mkdtempSync(join(tmpdir(), "lcm-vitest-config-parent-"));
    const root = join(parent, "owned-root");
    const createDirectory = vi.fn(mkdirSync);
    const secureDirectory = vi.fn(chmodSync);

    try {
      expect(createVitestRunRoot({
        environment: { LCM_TEST_ARTIFACT_ROOT: root },
        mkdirSync: createDirectory,
        chmodSync: secureDirectory,
      })).toBe(root);
      expect(createDirectory).toHaveBeenCalledWith(root, {
        mode: 0o700,
        recursive: false,
      });
      expect(secureDirectory).toHaveBeenCalledWith(root, 0o700);
      expect(lstatSync(root).isDirectory()).toBe(true);
      expect(lstatSync(root).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects unsafe overrides before adopting any preexisting state", () => {
    const parent = mkdtempSync(join(tmpdir(), "lcm-vitest-config-invalid-"));
    const existingDirectory = join(parent, "existing-directory");
    const existingFile = join(parent, "existing-file");
    const existingSymlink = join(parent, "existing-symlink");
    mkdirSync(existingDirectory, { mode: 0o755 });
    writeFileSync(existingFile, "sentinel", { mode: 0o600 });
    symlinkSync(existingDirectory, existingSymlink);
    const existingDirectoryMode = lstatSync(existingDirectory).mode & 0o777;
    const existingFileMode = lstatSync(existingFile).mode & 0o777;

    const invalidOverrides = [
      "relative-root",
      "   ",
      ` ${join(parent, "padded-root")} `,
      join(parent, "missing-parent", "fresh-root"),
      existingDirectory,
      existingFile,
      existingSymlink,
    ];
    const createDirectory = vi.fn(mkdirSync);
    const secureDirectory = vi.fn(chmodSync);

    try {
      for (const override of invalidOverrides) {
        expect(() => createVitestRunRoot({
          environment: { LCM_TEST_ARTIFACT_ROOT: override },
          mkdirSync: createDirectory,
          chmodSync: secureDirectory,
        })).toThrow();
      }
      expect(createDirectory).not.toHaveBeenCalled();
      expect(secureDirectory).not.toHaveBeenCalled();
      expect(lstatSync(existingDirectory).mode & 0o777).toBe(existingDirectoryMode);
      expect(lstatSync(existingFile).mode & 0o777).toBe(existingFileMode);
      expect(lstatSync(existingSymlink).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("propagates root creation and chmod failures", () => {
    const parent = mkdtempSync(join(tmpdir(), "lcm-vitest-config-failure-"));
    const creationFailureRoot = join(parent, "create-failure");
    const chmodFailureRoot = join(parent, "chmod-failure");
    const creationFailure = new Error("mkdir failed");
    const createDirectory = vi.fn(() => {
      throw creationFailure;
    });
    try {
      expect(() => createVitestRunRoot({
        environment: { LCM_TEST_ARTIFACT_ROOT: creationFailureRoot },
        mkdirSync: createDirectory,
      })).toThrow(creationFailure);

      const chmodFailure = new Error("chmod failed");
      const secureDirectory = vi.fn(() => {
        throw chmodFailure;
      });
      expect(() => createVitestRunRoot({
        environment: { LCM_TEST_ARTIFACT_ROOT: chmodFailureRoot },
        mkdirSync: vi.fn(),
        chmodSync: secureDirectory,
      })).toThrow(chmodFailure);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rolls back a newly created explicit root when chmod fails", () => {
    const parent = mkdtempSync(join(tmpdir(), "lcm-vitest-config-explicit-rollback-"));
    const root = join(parent, "owned-root");
    const chmodFailure = new Error("explicit chmod failed");

    try {
      expect(() => createVitestRunRoot({
        environment: { LCM_TEST_ARTIFACT_ROOT: root },
        chmodSync: (path, mode) => {
          chmodSync(path, mode);
          throw chmodFailure;
        },
      })).toThrow(chmodFailure);
      expect(() => lstatSync(root)).toThrow();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rolls back a newly created default root when chmod fails", () => {
    const parent = mkdtempSync(join(tmpdir(), "lcm-vitest-config-default-rollback-"));
    let root = "";
    const chmodFailure = new Error("default chmod failed");

    try {
      expect(() => createVitestRunRoot({
        environment: {},
        temporaryRoot: () => parent,
        mkdtempSync: (prefix) => {
          root = mkdtempSync(prefix);
          return root;
        },
        chmodSync: (path, mode) => {
          chmodSync(path, mode);
          throw chmodFailure;
        },
        registerProcessExit: vi.fn(),
      })).toThrow(chmodFailure);
      expect(root).not.toBe("");
      expect(() => lstatSync(root)).toThrow();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rolls back a secured default root when exit registration fails", () => {
    const parent = mkdtempSync(join(tmpdir(), "lcm-vitest-config-register-rollback-"));
    let root = "";
    const registrationFailure = new Error("registration failed");

    try {
      expect(() => createVitestRunRoot({
        environment: {},
        temporaryRoot: () => parent,
        mkdtempSync: (prefix) => {
          root = mkdtempSync(prefix);
          return root;
        },
        registerProcessExit: () => {
          throw registrationFailure;
        },
      })).toThrow(registrationFailure);
      expect(() => lstatSync(root)).toThrow();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("preserves the setup error when rollback removal fails", () => {
    const parent = mkdtempSync(join(tmpdir(), "lcm-vitest-config-rollback-error-"));
    const root = join(parent, "owned-root");
    const chmodFailure = new Error("original chmod failed");
    const rollbackFailure = new Error("rollback rm failed");

    try {
      expect(() => createVitestRunRoot({
        environment: { LCM_TEST_ARTIFACT_ROOT: root },
        chmodSync: () => {
          throw chmodFailure;
        },
        rmSync: () => {
          throw rollbackFailure;
        },
      })).toThrow(chmodFailure);
      expect(() => lstatSync(root)).not.toThrow();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("does not remove a root when validation or mkdir fails before ownership", () => {
    const parent = mkdtempSync(join(tmpdir(), "lcm-vitest-config-no-ownership-"));
    const existingRoot = join(parent, "existing-root");
    mkdirSync(existingRoot);
    writeFileSync(join(existingRoot, "sentinel"), "keep");
    const rollback = vi.fn();
    const mkdirFailure = new Error("mkdir failed");

    try {
      expect(() => createVitestRunRoot({
        environment: { LCM_TEST_ARTIFACT_ROOT: existingRoot },
        rmSync: rollback,
      })).toThrow();
      expect(rollback).not.toHaveBeenCalled();
      expect(() => createVitestRunRoot({
        environment: { LCM_TEST_ARTIFACT_ROOT: join(parent, "mkdir-failure") },
        mkdirSync: () => {
          throw mkdirFailure;
        },
        rmSync: rollback,
      })).toThrow(mkdirFailure);
      expect(rollback).not.toHaveBeenCalled();
      expect(lstatSync(join(existingRoot, "sentinel")).isFile()).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("does not let a second explicit claimant delete the first retained root", () => {
    const parent = mkdtempSync(join(tmpdir(), "lcm-vitest-config-explicit-claim-"));
    const root = join(parent, "shared-root");
    const rollback = vi.fn();

    try {
      expect(createVitestRunRoot({
        environment: { LCM_TEST_ARTIFACT_ROOT: root },
      })).toBe(root);
      writeFileSync(join(root, "sentinel"), "keep");
      expect(() => createVitestRunRoot({
        environment: { LCM_TEST_ARTIFACT_ROOT: root },
        rmSync: rollback,
      })).toThrow();
      expect(rollback).not.toHaveBeenCalled();
      expect(lstatSync(join(root, "sentinel")).isFile()).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it.each([
    [0, "success"],
    [1, "failure"],
    [130, "interruption"],
    [0, "no-tests"],
  ])("cleans a default root on process exit (%s, %s)", (code, _reason) => {
    const parent = mkdtempSync(join(tmpdir(), "lcm-vitest-config-exit-"));
    let root = "";
    let listener: ((code: number) => void) | undefined;

    try {
      root = createVitestRunRoot({
        environment: {},
        temporaryRoot: () => parent,
        registerProcessExit: (registered) => {
          listener = registered;
        },
      });
      expect(lstatSync(root).isDirectory()).toBe(true);
      listener?.(code);
      expect(() => lstatSync(root)).toThrow();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("retains an explicit root and registers no exit listener", () => {
    const parent = mkdtempSync(join(tmpdir(), "lcm-vitest-config-explicit-retain-"));
    const root = join(parent, "owned-root");
    const register = vi.fn();

    try {
      createVitestRunRoot({
        environment: { LCM_TEST_ARTIFACT_ROOT: root },
        registerProcessExit: register,
      });
      writeFileSync(join(root, "sentinel"), "keep");
      expect(register).not.toHaveBeenCalled();
      expect(lstatSync(join(root, "sentinel")).isFile()).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("makes default exit cleanup idempotent and removes exactly once", () => {
    const parent = mkdtempSync(join(tmpdir(), "lcm-vitest-config-exit-once-"));
    let listener: ((code: number) => void) | undefined;
    const remove = vi.fn(rmSync);

    try {
      const root = createVitestRunRoot({
        environment: {},
        temporaryRoot: () => parent,
        registerProcessExit: (registered) => {
          listener = registered;
        },
        rmSync: remove,
      });
      listener?.(0);
      listener?.(0);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith(root, { recursive: true, force: true });
      expect(() => lstatSync(root)).toThrow();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("swallows exit cleanup failures without changing process.exitCode", () => {
    const parent = mkdtempSync(join(tmpdir(), "lcm-vitest-config-exit-failure-"));
    let listener: ((code: number) => void) | undefined;
    const removeFailure = new Error("exit cleanup failed");
    const previousExitCode = process.exitCode;
    process.exitCode = 73;

    try {
      createVitestRunRoot({
        environment: {},
        temporaryRoot: () => parent,
        registerProcessExit: (registered) => {
          listener = registered;
        },
        rmSync: () => {
          throw removeFailure;
        },
      });
      expect(() => listener?.(1)).not.toThrow();
      expect(process.exitCode).toBe(73);
    } finally {
      process.exitCode = previousExitCode;
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("keeps two default exit listeners scoped to their captured roots", () => {
    const parent = mkdtempSync(join(tmpdir(), "lcm-vitest-config-exit-isolation-"));
    const listeners: Array<(code: number) => void> = [];

    try {
      const first = createVitestRunRoot({
        environment: {},
        temporaryRoot: () => parent,
        registerProcessExit: (listener) => listeners.push(listener),
      });
      const second = createVitestRunRoot({
        environment: {},
        temporaryRoot: () => parent,
        registerProcessExit: (listener) => listeners.push(listener),
      });
      expect(listeners).toHaveLength(2);
      listeners[0](0);
      expect(() => lstatSync(first)).toThrow();
      expect(lstatSync(second).isDirectory()).toBe(true);
      listeners[1](1);
      expect(() => lstatSync(second)).toThrow();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("creates and registers one root lazily through the resolver", () => {
    const createRunRoot = vi.fn(() => "/tmp/lcm-vitest-run-lazy-lifecycle");
    const resolver = createVitestConfigurationResolver({ createRunRoot });
    expect(createRunRoot).not.toHaveBeenCalled();
    resolver();
    resolver();
    expect(createRunRoot).toHaveBeenCalledTimes(1);
  });

  it("derives isolated artifact paths while preserving the established projects and thresholds", () => {
    const root = "/tmp/lcm-vitest-run-configured";
    const configured = createVitestConfiguration(root);

    expect(configured.cacheDir).toBe(join(root, "cache"));
    expect(configured.test?.coverage?.reportsDirectory).toBe(join(root, "coverage"));
    expect(configured.test?.outputFile).toEqual({
      junit: join(root, "test-report.junit.xml"),
    });
    const projects = configured.test?.projects ?? [];
    const parallelProject = projects.find(
      (project) => project.test?.name === "unit-parallel",
    );
    const packageProject = projects.find(
      (project) => project.test?.include?.includes("test/package-config.test.ts"),
    );
    expect(parallelProject?.test?.exclude).toContain("test/package-config.test.ts");
    expect(packageProject?.test?.fileParallelism).toBe(false);
    expect(configured.test?.setupFiles).toEqual(["test/setup/isolate-runtime-home.ts"]);
    expect(configured.test?.globalSetup).toEqual(["test/setup/runtime-home-global.ts"]);
    expect(configured.test?.coverage?.thresholds).toMatchObject({
      lines: 100,
      functions: 100,
      branches: 100,
      statements: 100,
    });
    expect(JSON.stringify(configured)).not.toContain("vitest-lcm-cache");
    expect(JSON.stringify(configured)).not.toContain('junit: "test-report.junit.xml"');
    expect(basename(configured.test?.coverage?.reportsDirectory ?? "")).toBe("coverage");
  });

  it("keeps test:ci reporters while removing the shared JUnit output flag", () => {
    const testCi = packageJson.scripts?.["test:ci"];
    expect(testCi).toBeTypeOf("string");
    expect(testCi).toMatch(/--reporter(?:=|\s+)default/u);
    expect(testCi).toMatch(/--reporter(?:=|\s+)junit/u);
    expect(testCi).toMatch(/--coverage\.reporter(?:=|\s+)lcov/u);
    expect(testCi).toMatch(/--coverage\.reporter(?:=|\s+)text/u);
    expect(testCi).not.toContain("--outputFile=test-report.junit.xml");
  });

  it("drains an isolated cleanup registry once while preserving failure isolation", () => {
    const registry = new Set<() => void>();
    const calls: string[] = [];
    registry.add(() => {
      calls.push("first");
      throw new Error("first cleanup failed");
    });
    registry.add(() => {
      calls.push("second");
    });

    expect(() => drainVitestRunRootCleanups(registry)).not.toThrow();
    expect(calls).toEqual(["first", "second"]);
    expect(registry).toHaveLength(0);

    drainVitestRunRootCleanups(registry);
    expect(calls).toEqual(["first", "second"]);
  });

  it("shares one exit listener across fresh default configuration evaluations", () => {
    const parent = mkdtempSync(join(tmpdir(), "lcm-vitest-config-reload-"));
    const parentOwnedRoot = join(parent, "parent-owned");
    const configPath = resolve(dirname(fileURLToPath(import.meta.url)), "../vitest.config.ts");
    mkdirSync(parentOwnedRoot, { mode: 0o700 });

    try {
      const result = runDefaultRootChild(parent, configPath);
      expect(result.after - result.before).toBe(1);
      expect(result.count).toBeGreaterThanOrEqual(12);
      expect(result.roots).toHaveLength(result.count);
      expect(new Set(result.roots)).toHaveLength(result.count);
      expect(result.allRootsExist).toBe(true);
      expect(result.warningNames.some(
        (warning) => warning.startsWith("MaxListenersExceededWarning|")
          && warning.includes("exit listeners"),
      )).toBe(false);
      for (const root of result.roots) {
        expect(existsSync(root)).toBe(false);
      }
      expect(existsSync(parentOwnedRoot)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("retains a fresh explicit root after an isolated child exits", () => {
    const parent = mkdtempSync(join(tmpdir(), "lcm-vitest-config-reload-explicit-"));
    const root = join(parent, "explicit-root");
    const configPath = resolve(dirname(fileURLToPath(import.meta.url)), "../vitest.config.ts");

    try {
      const result = runExplicitRootChild(parent, configPath, root);
      expect(result.after - result.before).toBe(0);
      expect(result.root).toBe(root);
      expect(existsSync(join(root, "sentinel"))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
