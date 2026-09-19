#!/usr/bin/env node
// Executes one CI test shard or merges every shard report.
//
//   node scripts/ci-vitest.mjs shard    # one `unit` matrix entry
//   node scripts/ci-vitest.mjs report   # the `report` job
//
// Both commands read their inputs from the environment so that untrusted
// values (file lists derived from pull request diffs) never pass through a
// shell. Every test path must match the planner's `TEST_FILE_PATTERN`; the
// executed file set is compared against the requested one after the run.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SHARD_NAMES, VITEST_PROJECTS } from "./ci-test-shards.mjs";
import { assertTestFiles } from "./ci-plan.mjs";

export const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const SHARD_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
export const BLOB_DIRECTORY = "blobs";

// Thresholds are evaluated by the merged report only; a single shard never
// sees the complete coverage map. The values are overridden here instead of
// in `vitest.config.ts` so the local `pnpm run test:ci` keeps its gate.
export const SHARD_COVERAGE_ARGUMENTS = Object.freeze([
  "--coverage",
  "--coverage.reporter=json-summary",
  "--coverage.thresholds.lines=0",
  "--coverage.thresholds.branches=0",
  "--coverage.thresholds.functions=0",
  "--coverage.thresholds.statements=0",
  "--coverage.thresholds.perFile=false",
]);

export const REPORT_COVERAGE_ARGUMENTS = Object.freeze([
  "--coverage",
  "--coverage.reporter=lcov",
  "--coverage.reporter=text",
]);

function parseJsonList(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value ?? "");
  } catch {
    throw new Error(`${label} must be a JSON array`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be a JSON array of strings`);
  }
  return parsed;
}

function parseBoolean(value, label) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} must be "true" or "false"`);
}

function artifactRoot(environment) {
  const root = environment.LCM_TEST_ARTIFACT_ROOT;
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw new Error("LCM_TEST_ARTIFACT_ROOT must be an absolute path");
  }
  return root;
}

export function shardOptions(environment) {
  const name = environment.LCM_CI_SHARD_NAME;
  if (typeof name !== "string" || !SHARD_NAME_PATTERN.test(name) || !SHARD_NAMES.includes(name)) {
    throw new Error(`LCM_CI_SHARD_NAME must be one of ${SHARD_NAMES.join(", ")}`);
  }
  const projects = parseJsonList(environment.LCM_CI_SHARD_PROJECTS, "LCM_CI_SHARD_PROJECTS");
  for (const project of projects) {
    if (!VITEST_PROJECTS.includes(project)) throw new Error(`unknown Vitest project: ${project}`);
  }
  if (projects.length === 0) throw new Error("LCM_CI_SHARD_PROJECTS must name at least one project");
  const files = assertTestFiles(parseJsonList(environment.LCM_CI_SHARD_FILES, "LCM_CI_SHARD_FILES"));
  if (files.length === 0) throw new Error("LCM_CI_SHARD_FILES must name at least one test file");
  if (new Set(files).size !== files.length) throw new Error("LCM_CI_SHARD_FILES contains duplicates");
  return {
    name,
    projects,
    files: [...files].sort(),
    coverage: parseBoolean(environment.LCM_CI_SHARD_COVERAGE, "LCM_CI_SHARD_COVERAGE"),
    root: artifactRoot(environment),
  };
}

export function shardArguments(options) {
  return [
    "node_modules/vitest/vitest.mjs",
    "run",
    "--dir",
    "test",
    ...options.projects.flatMap((project) => ["--project", project]),
    "--reporter=default",
    "--reporter=blob",
    `--outputFile.blob=${join(options.root, BLOB_DIRECTORY, `${options.name}.json`)}`,
    "--reporter=json",
    `--outputFile.json=${join(options.root, `shard-${options.name}.json`)}`,
    ...(options.coverage ? SHARD_COVERAGE_ARGUMENTS : []),
    ...options.files,
  ];
}

export function reportOptions(environment) {
  const expected = environment.LCM_CI_EXPECTED_FILE_COUNT;
  if (typeof expected !== "string" || !/^[1-9][0-9]*$/u.test(expected)) {
    throw new Error("LCM_CI_EXPECTED_FILE_COUNT must be a positive integer");
  }
  const blobs = environment.LCM_CI_BLOB_DIRECTORY;
  if (typeof blobs !== "string" || !isAbsolute(blobs)) {
    throw new Error("LCM_CI_BLOB_DIRECTORY must be an absolute path");
  }
  return {
    expectedFileCount: Number(expected),
    blobs,
    coverage: parseBoolean(environment.LCM_CI_COVERAGE, "LCM_CI_COVERAGE"),
    root: artifactRoot(environment),
  };
}

export function reportArguments(options) {
  return [
    "node_modules/vitest/vitest.mjs",
    "run",
    "--dir",
    "test",
    "--merge-reports",
    options.blobs,
    "--reporter=default",
    "--reporter=junit",
    "--reporter=json",
    `--outputFile.json=${join(options.root, "report.json")}`,
    ...(options.coverage ? REPORT_COVERAGE_ARGUMENTS : []),
  ];
}

// Files reported by Vitest's json reporter, repository-relative and sorted.
export function reportedFiles(json, root = repositoryRoot) {
  const report = JSON.parse(json);
  if (!Array.isArray(report?.testResults)) throw new Error("Vitest json report has no testResults");
  return [...new Set(report.testResults.map((result) => {
    if (typeof result?.name !== "string") throw new Error("Vitest json result without a name");
    return isAbsolute(result.name) ? relative(root, result.name).split("\\").join("/") : result.name;
  }))].sort();
}

export function assertSameFiles(expected, actual, label) {
  const missing = expected.filter((file) => !actual.includes(file));
  const extra = actual.filter((file) => !expected.includes(file));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`${label}: executed files differ from the plan (missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"})`);
  }
}

export function runVitest(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    stdio: "inherit",
    env: { ...process.env, ...options.env },
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function runShard(environment = process.env, dependencies = {}) {
  const run = dependencies.runVitest ?? runVitest;
  const read = dependencies.readFile ?? ((path) => readFileSync(path, "utf8"));
  const options = shardOptions(environment);
  // The artifact root must not exist yet: `vitest.config.ts` creates it fresh
  // and Vitest creates the blob directory for its own output file.
  const status = run(shardArguments(options));
  let json;
  try {
    json = read(join(options.root, `shard-${options.name}.json`));
  } catch (error) {
    if (status !== 0) return status;
    throw error;
  }
  const executed = reportedFiles(json);
  assertSameFiles(options.files, executed, `shard ${options.name}`);
  process.stdout.write(`shard ${options.name}: ${executed.length} test files executed, exit status ${status}\n`);
  return status;
}

export function runReport(environment = process.env, dependencies = {}) {
  const run = dependencies.runVitest ?? runVitest;
  const read = dependencies.readFile ?? ((path) => readFileSync(path, "utf8"));
  const list = dependencies.readDirectory ?? ((path) => readdirSync(path));
  const options = reportOptions(environment);
  const blobs = list(options.blobs).filter((entry) => entry.endsWith(".json")).sort();
  if (blobs.length === 0) throw new Error(`no shard blobs found in ${options.blobs}`);
  for (const blob of blobs) {
    const name = blob.slice(0, -".json".length);
    if (!SHARD_NAMES.includes(name)) throw new Error(`unexpected blob report: ${blob}`);
  }
  const status = run(reportArguments(options));
  const merged = reportedFiles(read(join(options.root, "report.json")));
  if (merged.length !== options.expectedFileCount) {
    throw new Error(`report: merged ${merged.length} test files but the plan expected ${options.expectedFileCount}`);
  }
  process.stdout.write(`report: merged ${blobs.length} shard blobs covering ${merged.length} test files, exit status ${status}\n`);
  return status;
}

export function main(argv = process.argv.slice(2), environment = process.env, dependencies = {}) {
  const [command, ...rest] = argv;
  if (rest.length > 0) throw new Error("ci-vitest takes exactly one command");
  if (command === "shard") return runShard(environment, dependencies);
  if (command === "report") return runReport(environment, dependencies);
  throw new Error("usage: ci-vitest.mjs <shard|report>");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`ci-vitest: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
