import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import packageJson from "../package.json";
import {
  createVitestConfiguration,
  createVitestConfigurationResolver,
  createVitestRunRoot,
} from "../vitest.config";

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
    });
    const second = createVitestRunRoot({
      environment,
      mkdtempSync: createTemporaryDirectory,
      chmodSync: secureDirectory,
      temporaryRoot: () => "/tmp",
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
});
