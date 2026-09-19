import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FULL_COVERAGE_REFS,
  GRAPH_INVISIBLE_INPUTS,
  LAUNCHD_TEST_FILES,
  POSTGRESQL_PATH_PATTERNS,
  SYSTEMD_TEST_FILES,
  TEST_FILE_PATTERN,
  assertTestFiles,
  changedPaths,
  classifyChanges,
  createPlan,
  githubOutputs,
  graphInvisibleTests,
  integrationFlags,
  isGraphVisible,
  listTests,
  main,
  parseArguments,
  parseListing,
  plan,
  placeholderMatrix,
  renderSummary,
  shardMatrix,
} from "../../scripts/ci-plan.mjs";
import { RUNNERS, SHARD_NAMES } from "../../scripts/ci-test-shards.mjs";

interface Listed {
  file: string;
  projectName: string;
}

const repositoryRoot = new URL("../../", import.meta.url).pathname;
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const MERGE_BASE = "c".repeat(40);
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "lcm-ci-plan-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function listing(entries: Array<[string, string]>): Listed[] {
  return entries.map(([file, projectName]) => ({ file, projectName }));
}

const suite = listing([
  ["test/a.test.ts", "unit-parallel"],
  ["test/b.test.ts", "unit-parallel"],
  ["test/daemon/lifecycle-systemd.integration.test.ts", "unit-parallel"],
  ["test/runtime-paths.test.ts", "unit-parallel"],
  ["test/package-config.test.ts", "unit-package"],
  ["test/daemon/remediation-string-regression.test.ts", "unit-parallel"],
  ["test/external-admission-workflow.test.ts", "unit-parallel"],
  ["test/release-workflows.test.ts", "unit-parallel"],
  ["test/scripts/version-packages.test.ts", "unit-parallel"],
  ["test/update-patterns-workflow.test.ts", "unit-parallel"],
  ["test/storage/portable-record-stream.test.ts", "unit-portable-boundaries"],
  ["test/e2e/harness.test.ts", "e2e"],
]);

describe("CI plan classification", () => {
  it("treats TypeScript under src, bin, installer, and test as graph-visible", () => {
    for (const path of ["src/a.ts", "src/nested/b.ts", "bin/lcm.ts", "installer/install.ts", "test/x.test.ts", "test/helpers/h.ts"]) {
      expect(isGraphVisible(path), path).toBe(true);
    }
    for (const path of [
      "src/prompts/x.yaml", "src/storage/postgresql/migrations/001.sql", "src/connectors/templates/a.md",
      "test/setup/isolate-runtime-home.ts", "test/fixtures/a.json", "package.json", "pnpm-lock.yaml",
      "vitest.config.ts", "tsconfig.json", ".github/workflows/ci.yml", "scripts/ci-plan.mjs", "docs/cli.md",
      // Fixtures are consumed outside the module graph (esbuild plugins, disk reads).
      "test/fixtures/session-end-process-admission.ts", "test/postgresql/fixtures/persistent-worker.integration.ts",
      "test/connectors/fixtures/x.ts", "test/fixtures/e2e/subagents/a.ts",
    ]) {
      expect(isGraphVisible(path), path).toBe(false);
    }
  });

  it("maps graph-invisible inputs to the tests that read them", () => {
    expect(graphInvisibleTests("docs/cli.md")).toEqual([...GRAPH_INVISIBLE_INPUTS[0].tests]);
    expect(graphInvisibleTests("README.md")).toEqual([...GRAPH_INVISIBLE_INPUTS[0].tests]);
    expect(graphInvisibleTests("LICENSE")).toEqual([...GRAPH_INVISIBLE_INPUTS[0].tests]);
    expect(graphInvisibleTests(".changeset/x.md")).toEqual([...GRAPH_INVISIBLE_INPUTS[1].tests]);
    expect(graphInvisibleTests("test/timezone-fixture.test.ts")).toEqual(["test/timezone-fixture-runner.test.ts"]);
    expect(graphInvisibleTests("src/memory/index.ts")).toEqual(["test/memory/search-type-contract.test.ts"]);
    expect(graphInvisibleTests("src/memory/other.ts")).toEqual([]);
    expect(graphInvisibleTests("package.json")).toEqual([]);
    expect(graphInvisibleTests("docs-old/x.md")).toEqual([]);
    for (const input of GRAPH_INVISIBLE_INPUTS) {
      for (const file of input.tests) {
        expect(suite.some((entry) => entry.file === file) || file.startsWith("test/"), file).toBe(true);
      }
    }
  });

  it("selects for graph-visible and mapped changes and falls back to full otherwise", () => {
    expect(classifyChanges(["src/a.ts", "test/a.test.ts"])).toEqual({ mode: "selective", reason: undefined, alwaysRun: [] });
    expect(classifyChanges(["docs/cli.md", "src/a.ts"])).toEqual({
      mode: "selective",
      reason: undefined,
      alwaysRun: [...GRAPH_INVISIBLE_INPUTS[0].tests].sort(),
    });
    expect(classifyChanges([".changeset/a.md", "docs/b.md"]).alwaysRun).toEqual(
      [...new Set([...GRAPH_INVISIBLE_INPUTS[0].tests, ...GRAPH_INVISIBLE_INPUTS[1].tests])].sort(),
    );
    // A spawned test file is graph-visible (it runs itself) and still maps
    // to the runner that executes it under other time zones.
    expect(classifyChanges(["test/timezone-fixture.test.ts"])).toEqual({
      mode: "selective",
      reason: undefined,
      alwaysRun: ["test/timezone-fixture-runner.test.ts"],
    });
    for (const path of ["package.json", "vitest.config.ts", "test/setup/x.ts", "src/a.sql", ".github/workflows/ci.yml", "scripts/x.mjs", "test/fixtures/a.jsonl"]) {
      expect(classifyChanges(["src/a.ts", path])).toEqual({ mode: "full", reason: path, alwaysRun: [] });
    }
    expect(classifyChanges([])).toEqual({ mode: "selective", reason: undefined, alwaysRun: [] });
  });

  it("accepts only repository-relative test files with a safe shape", () => {
    const accepted = [
      "test/a.test.ts", "test/hooks/compact.test.ts", "test/daemon/lifecycle-systemd.integration.test.ts",
      "test/scripts/ci-plan.test.ts", "test/e2e/flows/compact.test.ts", "test/coverage-400_x.test.ts",
    ];
    expect(assertTestFiles(accepted)).toBe(accepted);
    for (const rejected of [
      "src/a.ts", "test/a.ts", "test/../src/a.test.ts", "/test/a.test.ts", "test//a.test.ts", "test/a b.test.ts",
      "test/$(touch x).test.ts", "test/a;rm.test.ts", "test/a.test.ts\n", "test/\u00e9.test.ts", "", 42, null,
    ]) {
      expect(() => assertTestFiles([rejected as string]), String(rejected)).toThrow(/refusing test path/u);
      if (typeof rejected === "string") expect(TEST_FILE_PATTERN.test(rejected)).toBe(false);
    }
  });
});

describe("CI plan integration flags", () => {
  it("runs everything in full mode", () => {
    expect(integrationFlags({ mode: "full", changed: [], selected: [], postgresqlSelected: [] })).toEqual({
      postgresql: true, systemd: true, launchd: true,
    });
  });

  it("derives each integration job from the selected files or process-boundary paths", () => {
    const none = integrationFlags({ mode: "selective", changed: ["src/a.ts"], selected: ["test/a.test.ts"], postgresqlSelected: [] });
    expect(none).toEqual({ postgresql: false, systemd: false, launchd: false });
    for (const file of SYSTEMD_TEST_FILES) {
      expect(integrationFlags({ mode: "selective", changed: [], selected: [file], postgresqlSelected: [] }).systemd).toBe(true);
    }
    for (const file of LAUNCHD_TEST_FILES) {
      expect(integrationFlags({ mode: "selective", changed: [], selected: [file], postgresqlSelected: [] }).launchd).toBe(true);
    }
    expect(integrationFlags({ mode: "selective", changed: [], selected: [], postgresqlSelected: ["test/postgresql/a.integration.ts"] }).postgresql).toBe(true);
    for (const path of [
      "bin/lcm.ts", "installer/install.ts", "src/cli/x.ts", "src/daemon/server.ts", "src/storage/postgresql/runtime.ts",
      "test/postgresql/a.integration.ts", "scripts/postgresql-harness.mjs", "scripts/ci-environment.mjs",
      "scripts/test-temp-root.mjs", "vitest.postgresql.config.ts",
    ]) {
      expect(POSTGRESQL_PATH_PATTERNS.some((pattern) => pattern.test(path)), path).toBe(true);
      expect(integrationFlags({ mode: "selective", changed: [path], selected: [], postgresqlSelected: [] }).postgresql).toBe(true);
    }
    expect(POSTGRESQL_PATH_PATTERNS.some((pattern) => pattern.test("src/storage/sqlite/x.ts"))).toBe(false);
  });
});

describe("CI plan creation", () => {
  it("runs the complete suite with coverage on main and release pushes", () => {
    expect(FULL_COVERAGE_REFS).toEqual(["refs/heads/main", "refs/heads/release"]);
    for (const ref of FULL_COVERAGE_REFS) {
      const result = createPlan({ event: "push", ref, changed: [], classification: undefined, listed: suite, allListed: suite, postgresqlSelected: [] });
      expect(result).toMatchObject({ mode: "full", coverage: true, unit: true, postgresql: true, systemd: true, launchd: true, expectedFileCount: suite.length });
      expect(result.reason).toBe(`push to ${ref}`);
      expect(result.shards.map((shard) => shard.name)).toEqual(["unit-1", "unit-2", "portable-stream", "serial"]);
    }
    const other = createPlan({ event: "push", ref: "refs/heads/feature", changed: [], classification: undefined, listed: suite, allListed: suite, postgresqlSelected: [] });
    expect(other).toMatchObject({ mode: "full", coverage: false });
  });

  it("runs the full suite without coverage when a pull request forces it", () => {
    const classification = { mode: "full", reason: "package.json", alwaysRun: [] };
    const result = createPlan({ event: "pull_request", ref: "refs/pull/1/merge", changed: ["package.json"], classification, listed: suite, allListed: suite, postgresqlSelected: [] });
    expect(result).toMatchObject({ mode: "full", coverage: false, reason: "package.json", expectedFileCount: suite.length, postgresql: true });
  });

  it("selects the related files plus always-run files and prunes empty shards", () => {
    const classification = { mode: "selective", reason: undefined, alwaysRun: ["test/package-config.test.ts"] };
    const listed = listing([["test/a.test.ts", "unit-parallel"], ["test/runtime-paths.test.ts", "unit-parallel"]]);
    const result = createPlan({ event: "merge_group", ref: "refs/heads/gh-readonly-queue/main/pr-1", changed: ["src/a.ts", "docs/x.md"], classification, listed, allListed: suite, postgresqlSelected: [] });
    expect(result).toMatchObject({ mode: "selective", coverage: false, unit: true, postgresql: false, systemd: false, launchd: true, expectedFileCount: 3, reason: undefined });
    expect(result.selected).toEqual(["test/a.test.ts", "test/package-config.test.ts", "test/runtime-paths.test.ts"]);
    expect(result.shards.map((shard) => shard.name)).toEqual(["unit-1", "unit-2", "serial"]);
    expect(result.shards.find((shard) => shard.name === "serial")?.files).toEqual(["test/package-config.test.ts"]);
  });

  it("reports no unit work when nothing is related and refuses unknown always-run files", () => {
    const empty = createPlan({ event: "pull_request", ref: "r", changed: ["src/a.ts"], classification: { mode: "selective", reason: undefined, alwaysRun: [] }, listed: [], allListed: suite, postgresqlSelected: [] });
    expect(empty).toMatchObject({ unit: false, shards: [], expectedFileCount: 0, selected: [] });
    expect(() => createPlan({ event: "pull_request", ref: "r", changed: [], classification: { mode: "selective", reason: undefined, alwaysRun: ["test/missing.test.ts"] }, listed: [], allListed: suite, postgresqlSelected: [] }))
      .toThrow(/not part of the suite/u);
    const listedBad = listing([["test/$(x).test.ts", "unit-parallel"]]);
    expect(() => createPlan({ event: "push", ref: "refs/heads/main", changed: [], classification: undefined, listed: listedBad, allListed: listedBad, postgresqlSelected: [] }))
      .toThrow(/refusing test path/u);
  });

  it("emits scalar matrix entries and a placeholder when no shard runs", () => {
    const result = createPlan({ event: "push", ref: "refs/heads/main", changed: [], classification: undefined, listed: suite, allListed: suite, postgresqlSelected: [] });
    const outputs = githubOutputs(result);
    expect(outputs.slice(0, 7)).toEqual([
      "mode=full", "coverage=true", "unit=true", "postgresql=true", "systemd=true", "launchd=true", `expected-file-count=${suite.length}`,
    ]);
    expect(outputs[7]).toMatch(/^shards=\{"include":\[/u);
    expect(outputs.every((line) => !line.includes("\n"))).toBe(true);
    const matrix = JSON.parse(outputs[7].slice("shards=".length)) as { include: Array<Record<string, string>> };
    expect(matrix).toEqual(shardMatrix(result.shards));
    for (const entry of matrix.include) {
      expect(Object.keys(entry).sort()).toEqual(["files", "name", "projects", "runner"]);
      expect(typeof entry.files).toBe("string");
      expect(typeof entry.projects).toBe("string");
      expect(SHARD_NAMES).toContain(entry.name);
      expect(JSON.parse(entry.files).length).toBeGreaterThan(0);
    }
    expect(shardMatrix([])).toEqual(placeholderMatrix());
    expect(placeholderMatrix()).toEqual({ include: [{ name: "none", runner: RUNNERS.small, projects: "[]", files: "[]" }] });
  });

  it("renders a readable summary and neutralizes hostile path characters", () => {
    const hostile = "docs/\u0007\`rm\`|x.md";
    const classification = { mode: "selective", reason: undefined, alwaysRun: [] };
    const result = createPlan({ event: "pull_request", ref: "refs/pull/2/merge", changed: ["src/a.ts", hostile], classification, listed: listing([["test/a.test.ts", "unit-parallel"]]), allListed: suite, postgresqlSelected: [] });
    const summary = renderSummary(result);
    expect(summary).toContain("## CI plan");
    expect(summary).toContain("- Mode: **selective**");
    expect(summary).toContain("| unit-1 | blacksmith-8vcpu-ubuntu-2404 | unit-parallel | 1 |");
    expect(summary).toContain("| serial | - | - | 0 |");
    expect(summary).toContain("- \`test/a.test.ts\`");
    expect(summary).toContain("docs/??rm??x.md");
    expect(summary).not.toContain("\u0007");
    const full = renderSummary(createPlan({ event: "push", ref: "refs/heads/main", changed: [], classification: undefined, listed: suite, allListed: suite, postgresqlSelected: [] }));
    expect(full).toContain("(push to refs/heads/main)");
    expect(full).not.toContain("<details>");
  });
});

describe("CI plan process boundary", () => {
  it("diffs the merge base against the head with NUL-separated paths", () => {
    const calls: string[][] = [];
    const git = (args: string[]): string => {
      calls.push(args);
      if (args[0] === "merge-base") return `${MERGE_BASE}\n`;
      return "src/z.ts\0docs/a b.md\0";
    };
    expect(changedPaths(BASE, HEAD, git)).toEqual({ mergeBase: MERGE_BASE, changed: ["docs/a b.md", "src/z.ts"] });
    expect(calls).toEqual([
      ["merge-base", BASE, HEAD],
      ["diff", "--name-only", "--no-renames", "-z", MERGE_BASE, HEAD],
    ]);
    expect(() => changedPaths("HEAD~1", HEAD, git)).toThrow(/full commit SHAs/u);
    expect(() => changedPaths(BASE, "", git)).toThrow(/full commit SHAs/u);
    expect(() => changedPaths(BASE, HEAD, () => "not-a-sha\n")).toThrow(/merge-base/u);
  });

  it("parses Vitest listings into sorted repository-relative entries", () => {
    const parsed = parseListing(JSON.stringify([
      { file: "/repo/test/b.test.ts", projectName: "unit-parallel" },
      { file: "test/a.test.ts" },
    ]), "/repo");
    expect(parsed).toEqual([
      { file: "test/a.test.ts", projectName: "" },
      { file: "test/b.test.ts", projectName: "unit-parallel" },
    ]);
    expect(() => parseListing("{}")).toThrow(/array/u);
    expect(() => parseListing("[{}]")).toThrow(/without file/u);
    expect(() => parseListing(JSON.stringify([{ file: "x", projectName: 1 }]))).toThrow(/projectName/u);
  });

  it("lists through an explicit JSON output file and never a bare --json", () => {
    const seen: string[][] = [];
    const run = (_command: string, args: string[]): string => {
      seen.push(args);
      const output = args[args.indexOf("--json") + 1];
      writeFileSync(output, JSON.stringify([{ file: `${repositoryRoot}test/a.test.ts`, projectName: "unit-parallel" }]));
      return "";
    };
    expect(listTests({ run })).toEqual([{ file: "test/a.test.ts", projectName: "unit-parallel" }]);
    expect(listTests({ config: "vitest.postgresql.config.ts", changedSince: MERGE_BASE, run })).toHaveLength(1);
    expect(seen[0].slice(0, 3)).toEqual(["node_modules/vitest/vitest.mjs", "list", "--filesOnly"]);
    expect(seen[0][3]).toBe("--json");
    expect(seen[0][4]).toMatch(/lcm-ci-plan-.*listing\.json$/u);
    expect(seen[0].slice(5)).toEqual(["--dir", "test"]);
    expect(seen[1].slice(5)).toEqual(["--config", "vitest.postgresql.config.ts", "--changed", MERGE_BASE]);
    expect(seen.flat().some((argument) => argument.startsWith("--json="))).toBe(false);
  });

  it("parses --key value pairs only", () => {
    expect(parseArguments(["--event", "push", "--ref", "refs/heads/main"])).toEqual({ event: "push", ref: "refs/heads/main" });
    expect(parseArguments([])).toEqual({});
    expect(() => parseArguments(["--event"])).toThrow(/invalid argument/u);
    expect(() => parseArguments(["event", "push"])).toThrow(/invalid argument/u);
  });

  it("plans pushes with one listing and pull requests with the changed listings", () => {
    const listCalls: Array<Record<string, string | undefined>> = [];
    const dependencies = {
      listTests: (options: { config?: string; changedSince?: string }) => {
        listCalls.push({ config: options.config, changedSince: options.changedSince });
        if (options.config !== undefined) return [{ file: "test/postgresql/a.integration.ts", projectName: "" }];
        if (options.changedSince !== undefined) return listing([["test/a.test.ts", "unit-parallel"]]);
        return suite;
      },
      changedPaths: () => ({ mergeBase: MERGE_BASE, changed: ["src/a.ts"] }),
    };
    expect(plan({ event: "push", ref: "refs/heads/main" }, dependencies)).toMatchObject({ mode: "full", coverage: true });
    expect(listCalls).toEqual([{ config: undefined, changedSince: undefined }]);
    listCalls.splice(0);
    const selective = plan({ event: "pull_request", ref: "refs/pull/1/merge", base: BASE, head: HEAD }, dependencies);
    expect(selective).toMatchObject({ mode: "selective", selected: ["test/a.test.ts"], postgresql: true, expectedFileCount: 1 });
    expect(listCalls).toEqual([
      { config: undefined, changedSince: undefined },
      { config: undefined, changedSince: MERGE_BASE },
      { config: "vitest.postgresql.config.ts", changedSince: MERGE_BASE },
    ]);
    listCalls.splice(0);
    const forced = plan({ event: "merge_group", ref: "r", base: BASE, head: HEAD }, {
      ...dependencies,
      changedPaths: () => ({ mergeBase: MERGE_BASE, changed: ["pnpm-lock.yaml"] }),
    });
    expect(forced).toMatchObject({ mode: "full", coverage: false, reason: "pnpm-lock.yaml" });
    expect(listCalls).toEqual([{ config: undefined, changedSince: undefined }]);
    expect(() => plan({ ref: "r" }, dependencies)).toThrow(/--event/u);
    expect(plan({ event: "workflow_dispatch", ref: "r" }, dependencies)).toMatchObject({ mode: "full", coverage: false });
  });

  it("writes GitHub outputs and the step summary", () => {
    const directory = temporaryDirectory();
    const outputPath = join(directory, "output");
    const summaryPath = join(directory, "summary");
    const dependencies = { listTests: () => suite, changedPaths: () => ({ mergeBase: MERGE_BASE, changed: [] }) };
    const result = main(["--event", "push", "--ref", "refs/heads/main"], { GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: summaryPath }, dependencies);
    expect(result.plan.mode).toBe("full");
    expect(readFileSync(outputPath, "utf8")).toBe(result.outputs.join("\n") + "\n");
    expect(readFileSync(summaryPath, "utf8")).toBe(result.summary);
    const quiet = main(["--event", "push", "--ref", "refs/heads/main"], {}, dependencies);
    expect(quiet.outputs).toEqual(result.outputs);
  });

  it("agrees with the real Vitest configuration for a main push", () => {
    const result = plan({ event: "push", ref: "refs/heads/main" });
    expect(result.expectedFileCount).toBeGreaterThan(300);
    expect(result.shards.map((shard) => shard.name)).toEqual(SHARD_NAMES);
    expect(result.selected).toContain("test/scripts/ci-plan.test.ts");
    for (const input of GRAPH_INVISIBLE_INPUTS) {
      for (const file of input.tests) expect(result.selected, file).toContain(file);
    }
    for (const file of [...SYSTEMD_TEST_FILES, ...LAUNCHD_TEST_FILES]) expect(result.selected, file).toContain(file);
  }, 120_000);
});

describe("graph-invisible input table completeness", () => {
  // Direct disk reads of repository inputs, keyed by the planner input that
  // must list the reading test file. Each input is checked on its own so a
  // file mapped under one input cannot satisfy another.
  const readers: Record<string, RegExp[]> = {
    documentation: [
      /new URL\("(?:\.\.\/)*(?:docs\/|README\.md|ACKNOWLEDGMENTS\.md|LICENSE)/u,
      /readRepositoryFile\("(?:docs\/|README\.md|ACKNOWLEDGMENTS\.md|LICENSE)/u,
    ],
    changesets: [/new URL\("(?:\.\.\/)*\.changeset\//u],
    // A child Vitest invocation of the fixture file.
    "spawned-tests": [/"run", "test\/timezone-fixture\.test\.ts"/u],
    // A source file resolved for the TypeScript compiler API rather than imported.
    "compiled-sources": [/resolve\(process\.cwd\(\), "src\/[^"]+\.ts"\)/u],
  };

  function* testFiles(directory: string): Generator<string> {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) yield* testFiles(path);
      else if (entry.isFile() && entry.name.endsWith(".test.ts")) yield path;
    }
  }

  it("lists every test file that reads documentation or changesets from disk under the matching input", () => {
    expect(GRAPH_INVISIBLE_INPUTS.map((input) => input.name)).toEqual(Object.keys(readers));
    const sources = [...testFiles(join(repositoryRoot, "test"))]
      .map((path) => ({ file: path.slice(repositoryRoot.length), source: readFileSync(path, "utf8") }));
    for (const input of GRAPH_INVISIBLE_INPUTS) {
      const mapped = new Set(input.tests);
      const missing = sources
        .filter(({ file }) => !input.pattern.test(file))
        .filter(({ source }) => readers[input.name]!.some((reader) => reader.test(source)))
        .map(({ file }) => file)
        .filter((file) => !mapped.has(file));
      expect(missing, input.name).toEqual([]);
      for (const file of mapped) expect(readdirSync(join(repositoryRoot, file, "..")), file).toContain(file.split("/").at(-1));
    }
    // The gap the union hid: docs/releasing.md is read by the release workflow test.
    expect(GRAPH_INVISIBLE_INPUTS[0].tests).toContain("test/release-workflows.test.ts");
  });
});
