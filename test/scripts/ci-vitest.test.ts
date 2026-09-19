import { describe, expect, it } from "vitest";
import {
  BLOB_DIRECTORY,
  REPORT_COVERAGE_ARGUMENTS,
  SHARD_COVERAGE_ARGUMENTS,
  assertSameFiles,
  main,
  reportArguments,
  reportOptions,
  reportedFiles,
  repositoryRoot,
  runReport,
  runShard,
  shardArguments,
  shardOptions,
} from "../../scripts/ci-vitest.mjs";

const root = "/tmp/lcm-ci-vitest-test-root";

function shardEnvironment(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    LCM_CI_SHARD_NAME: "unit-1",
    LCM_CI_SHARD_PROJECTS: JSON.stringify(["unit-parallel"]),
    LCM_CI_SHARD_FILES: JSON.stringify(["test/b.test.ts", "test/a.test.ts"]),
    LCM_CI_SHARD_COVERAGE: "true",
    LCM_TEST_ARTIFACT_ROOT: root,
    ...overrides,
  };
}

function reportEnvironment(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    LCM_CI_EXPECTED_FILE_COUNT: "2",
    LCM_CI_BLOB_DIRECTORY: "/tmp/lcm-ci-vitest-test-blobs",
    LCM_CI_COVERAGE: "false",
    LCM_TEST_ARTIFACT_ROOT: root,
    ...overrides,
  };
}

function jsonReport(files: string[]): string {
  return JSON.stringify({ testResults: files.map((name) => ({ name: `${repositoryRoot}/${name}`, status: "passed" })) });
}

describe("CI shard execution", () => {
  it("validates every shard input before anything runs", () => {
    expect(shardOptions(shardEnvironment())).toEqual({
      name: "unit-1",
      projects: ["unit-parallel"],
      files: ["test/a.test.ts", "test/b.test.ts"],
      coverage: true,
      root,
    });
    const rejected: Array<[Record<string, string | undefined>, RegExp]> = [
      [{ LCM_CI_SHARD_NAME: "unit-3" }, /LCM_CI_SHARD_NAME/u],
      [{ LCM_CI_SHARD_NAME: "Unit-1" }, /LCM_CI_SHARD_NAME/u],
      [{ LCM_CI_SHARD_NAME: undefined }, /LCM_CI_SHARD_NAME/u],
      [{ LCM_CI_SHARD_PROJECTS: "unit-parallel" }, /JSON array/u],
      [{ LCM_CI_SHARD_PROJECTS: "[1]" }, /array of strings/u],
      [{ LCM_CI_SHARD_PROJECTS: "[]" }, /at least one project/u],
      [{ LCM_CI_SHARD_PROJECTS: JSON.stringify(["browser"]) }, /unknown Vitest project/u],
      [{ LCM_CI_SHARD_FILES: "[]" }, /at least one test file/u],
      [{ LCM_CI_SHARD_FILES: JSON.stringify(["src/a.ts"]) }, /refusing test path/u],
      [{ LCM_CI_SHARD_FILES: JSON.stringify(["test/a.test.ts", "test/a.test.ts"]) }, /duplicates/u],
      [{ LCM_CI_SHARD_COVERAGE: "yes" }, /LCM_CI_SHARD_COVERAGE/u],
      [{ LCM_TEST_ARTIFACT_ROOT: "relative/root" }, /LCM_TEST_ARTIFACT_ROOT/u],
      [{ LCM_TEST_ARTIFACT_ROOT: undefined }, /LCM_TEST_ARTIFACT_ROOT/u],
    ];
    for (const [overrides, message] of rejected) {
      expect(() => shardOptions(shardEnvironment(overrides)), JSON.stringify(overrides)).toThrow(message);
    }
  });

  it("builds the Vitest command with blob and json reporters, disabled thresholds, and the exact files", () => {
    const withCoverage = shardArguments(shardOptions(shardEnvironment()));
    expect(withCoverage).toEqual([
      "node_modules/vitest/vitest.mjs", "run", "--dir", "test", "--project", "unit-parallel",
      "--reporter=blob", `--outputFile.blob=${root}/${BLOB_DIRECTORY}/unit-1.json`,
      "--reporter=json", `--outputFile.json=${root}/shard-unit-1.json`,
      ...SHARD_COVERAGE_ARGUMENTS,
      "test/a.test.ts", "test/b.test.ts",
    ]);
    expect(SHARD_COVERAGE_ARGUMENTS).toContain("--coverage.thresholds.perFile=false");
    expect(SHARD_COVERAGE_ARGUMENTS.filter((argument) => /thresholds\.(?:lines|branches|functions|statements)=0$/u.test(argument))).toHaveLength(4);
    const withoutCoverage = shardArguments(shardOptions(shardEnvironment({
      LCM_CI_SHARD_COVERAGE: "false",
      LCM_CI_SHARD_NAME: "serial",
      LCM_CI_SHARD_PROJECTS: JSON.stringify(["unit-package", "e2e"]),
    })));
    expect(withoutCoverage).not.toContain("--coverage");
    expect(withoutCoverage.slice(4, 8)).toEqual(["--project", "unit-package", "--project", "e2e"]);
    expect(withoutCoverage.some((argument) => argument.startsWith("--coverage"))).toBe(false);
  });

  it("runs the shard and proves the executed files equal the plan", () => {
    const calls: string[][] = [];
    const status = runShard(shardEnvironment(), {
      runVitest: (args: string[]) => { calls.push(args); return 0; },
      readFile: () => jsonReport(["test/a.test.ts", "test/b.test.ts"]),
    });
    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(() => runShard(shardEnvironment(), {
      runVitest: () => 0,
      readFile: () => jsonReport(["test/a.test.ts", "test/c.test.ts"]),
    })).toThrow(/missing: test\/b\.test\.ts; unexpected: test\/c\.test\.ts/u);
    expect(runShard(shardEnvironment(), {
      runVitest: () => 1,
      readFile: () => jsonReport(["test/a.test.ts", "test/b.test.ts"]),
    })).toBe(1);
    expect(runShard(shardEnvironment(), {
      runVitest: () => 2,
      readFile: () => { throw new Error("ENOENT"); },
    })).toBe(2);
    expect(() => runShard(shardEnvironment(), {
      runVitest: () => 0,
      readFile: () => { throw new Error("ENOENT"); },
    })).toThrow(/ENOENT/u);
  });

  it("reads json reporter output into sorted repository-relative names", () => {
    expect(reportedFiles(jsonReport(["test/b.test.ts", "test/a.test.ts", "test/a.test.ts"]))).toEqual([
      "test/a.test.ts", "test/b.test.ts",
    ]);
    expect(reportedFiles(JSON.stringify({ testResults: [{ name: "/repo/test/z.test.ts" }, { name: "test/y.test.ts" }] }), "/repo"))
      .toEqual(["test/y.test.ts", "test/z.test.ts"]);
    expect(() => reportedFiles("{}")).toThrow(/testResults/u);
    expect(() => reportedFiles(JSON.stringify({ testResults: [{}] }))).toThrow(/without a name/u);
    expect(() => assertSameFiles(["a"], ["a"], "x")).not.toThrow();
    expect(() => assertSameFiles(["a"], [], "x")).toThrow(/x: executed files differ .*missing: a; unexpected: none/u);
  });
});

describe("CI report merge", () => {
  it("validates report inputs and builds the merge command", () => {
    expect(reportOptions(reportEnvironment())).toEqual({
      expectedFileCount: 2,
      blobs: "/tmp/lcm-ci-vitest-test-blobs",
      coverage: false,
      root,
    });
    for (const [overrides, message] of [
      [{ LCM_CI_EXPECTED_FILE_COUNT: "0" }, /positive integer/u],
      [{ LCM_CI_EXPECTED_FILE_COUNT: "x" }, /positive integer/u],
      [{ LCM_CI_BLOB_DIRECTORY: "blobs" }, /LCM_CI_BLOB_DIRECTORY/u],
      [{ LCM_CI_COVERAGE: "" }, /LCM_CI_COVERAGE/u],
    ] as Array<[Record<string, string>, RegExp]>) {
      expect(() => reportOptions(reportEnvironment(overrides))).toThrow(message);
    }
    expect(reportArguments(reportOptions(reportEnvironment()))).toEqual([
      "node_modules/vitest/vitest.mjs", "run", "--dir", "test", "--merge-reports", "/tmp/lcm-ci-vitest-test-blobs",
      "--reporter=default", "--reporter=junit", "--reporter=json", `--outputFile.json=${root}/report.json`,
    ]);
    const covered = reportArguments(reportOptions(reportEnvironment({ LCM_CI_COVERAGE: "true" })));
    expect(covered.slice(-REPORT_COVERAGE_ARGUMENTS.length)).toEqual([...REPORT_COVERAGE_ARGUMENTS]);
    expect(REPORT_COVERAGE_ARGUMENTS).toEqual(["--coverage", "--coverage.reporter=lcov", "--coverage.reporter=text"]);
    expect(covered.some((argument) => argument.includes("thresholds"))).toBe(false);
  });

  it("merges only known shard blobs and checks the merged file count", () => {
    const dependencies = {
      runVitest: () => 0,
      readFile: () => jsonReport(["test/a.test.ts", "test/b.test.ts"]),
      readDirectory: () => ["unit-2.json", "unit-1.json", "notes.txt"],
    };
    expect(runReport(reportEnvironment(), dependencies)).toBe(0);
    expect(runReport(reportEnvironment(), { ...dependencies, runVitest: () => 1 })).toBe(1);
    expect(() => runReport(reportEnvironment(), { ...dependencies, readDirectory: () => [] })).toThrow(/no shard blobs/u);
    expect(() => runReport(reportEnvironment(), { ...dependencies, readDirectory: () => ["unit-9.json"] })).toThrow(/unexpected blob report/u);
    expect(() => runReport(reportEnvironment({ LCM_CI_EXPECTED_FILE_COUNT: "3" }), dependencies)).toThrow(/merged 2 test files but the plan expected 3/u);
  });

  it("dispatches exactly one command", () => {
    const dependencies = {
      runVitest: () => 0,
      readFile: () => jsonReport(["test/a.test.ts", "test/b.test.ts"]),
      readDirectory: () => ["unit-1.json"],
    };
    expect(main(["shard"], shardEnvironment(), dependencies)).toBe(0);
    expect(main(["report"], reportEnvironment(), dependencies)).toBe(0);
    expect(() => main(["merge"], reportEnvironment(), dependencies)).toThrow(/usage/u);
    expect(() => main([], reportEnvironment(), dependencies)).toThrow(/usage/u);
    expect(() => main(["shard", "extra"], shardEnvironment(), dependencies)).toThrow(/exactly one command/u);
  });
});
