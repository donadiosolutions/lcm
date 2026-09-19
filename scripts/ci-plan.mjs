#!/usr/bin/env node
// CI planner. Runs once per workflow run in the `plan` job and decides what
// the rest of the graph executes:
//
//   - `mode`: `full` runs every test file; `selective` runs only the files
//     that Vitest's module graph relates to the changed paths, plus the files
//     listed for graph-invisible inputs (docs, changesets, ...).
//   - `coverage`: pushes to `main`/`release` also collect coverage; the
//     `report` job merges the shard blobs and enforces the 100% thresholds.
//   - `shards`: the GitHub Actions matrix for the `unit` job, one entry per
//     runner, built from `scripts/ci-test-shards.mjs`.
//   - `postgresql`, `systemd`, `launchd`: whether the integration jobs run.
//
// Everything that cannot be reasoned about from the module graph falls back to
// a full run. Paths come from untrusted pull requests, so every test file that
// reaches a shell later must match `TEST_FILE_PATTERN` or the plan fails.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SHARD_NAMES, RUNNERS, assignShards } from "./ci-test-shards.mjs";

export const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const FULL_COVERAGE_REFS = Object.freeze(["refs/heads/main", "refs/heads/release"]);
export const TEST_FILE_PATTERN = /^test\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.[A-Za-z0-9_.-]*test\.ts$/u;
export const SHA_PATTERN = /^[0-9a-f]{40}$/u;

// Changes to these paths are visible to Vitest's module graph: a test file
// either is one of them or imports them (directly or transitively). Fixture
// directories are excluded: fixtures are read from disk or bundled by test
// plugins, so a change to one has no module edge and must force a full run.
export const GRAPH_VISIBLE_PATTERNS = Object.freeze([
  /^src\/.+\.ts$/u,
  /^bin\/.+\.ts$/u,
  /^installer\/.+\.ts$/u,
  /^test\/(?!setup\/)(?:(?!fixtures\/).)+\.ts$/u,
]);

// Paths that tests consume without importing them: documentation and
// changesets read from disk, and test files another test spawns as a child
// Vitest run. A change to one of them cannot be traced through the module
// graph, so the listed test files always run, whether or not the path is
// itself graph-visible. `test/scripts/ci-plan.test.ts` checks that every test
// file that literally references one of these paths is listed here.
export const GRAPH_INVISIBLE_INPUTS = Object.freeze([
  Object.freeze({
    name: "documentation",
    pattern: /^(?:docs\/|README\.md$|ACKNOWLEDGMENTS\.md$|LICENSE$)/u,
    tests: Object.freeze([
      "test/package-config.test.ts",
      "test/daemon/remediation-string-regression.test.ts",
      "test/external-admission-workflow.test.ts",
      "test/release-workflows.test.ts",
    ]),
  }),
  Object.freeze({
    name: "changesets",
    pattern: /^\.changeset\//u,
    tests: Object.freeze([
      "test/release-workflows.test.ts",
      "test/scripts/version-packages.test.ts",
      "test/update-patterns-workflow.test.ts",
    ]),
  }),
  Object.freeze({
    name: "spawned-tests",
    pattern: /^test\/timezone-fixture\.test\.ts$/u,
    tests: Object.freeze(["test/timezone-fixture-runner.test.ts"]),
  }),
]);

// The PostgreSQL conformance harness exercises the packed CLI and daemon in a
// container, which the module graph of `test/postgresql/**` does not see.
export const POSTGRESQL_PATH_PATTERNS = Object.freeze([
  /^bin\//u,
  /^installer\//u,
  /^src\/cli\//u,
  /^src\/daemon\//u,
  /^src\/storage\/postgresql\//u,
  /^test\/postgresql\//u,
  /^scripts\/postgresql-[^/]+\.mjs$/u,
  /^scripts\/ci-environment\.mjs$/u,
  /^scripts\/test-temp-root\.mjs$/u,
  /^vitest\.postgresql\.config\.ts$/u,
]);

export const SYSTEMD_TEST_FILES = Object.freeze([
  "test/daemon/lifecycle-isolation.test.ts",
  "test/daemon/lifecycle-systemd.integration.test.ts",
  "test/daemon/systemd-credential-loader.test.ts",
  "test/runtime-paths-systemd.integration.test.ts",
]);

export const LAUNCHD_TEST_FILES = Object.freeze([
  "test/daemon/lifecycle-launchd.integration.test.ts",
  "test/runtime-paths.test.ts",
]);

export function isGraphVisible(path) {
  return GRAPH_VISIBLE_PATTERNS.some((pattern) => pattern.test(path));
}

export function graphInvisibleTests(path) {
  return GRAPH_INVISIBLE_INPUTS.filter((input) => input.pattern.test(path)).flatMap((input) => input.tests);
}

// Decides the mode from the changed paths alone. Returns the always-run test
// files contributed by graph-invisible inputs and the first path that forced a
// full run, if any.
export function classifyChanges(changed) {
  const alwaysRun = new Set();
  for (const path of changed) {
    const mapped = graphInvisibleTests(path);
    for (const test of mapped) alwaysRun.add(test);
    if (mapped.length === 0 && !isGraphVisible(path)) return { mode: "full", reason: path, alwaysRun: [] };
  }
  return { mode: "selective", reason: undefined, alwaysRun: [...alwaysRun].sort() };
}

export function assertTestFiles(files) {
  for (const file of files) {
    if (typeof file !== "string" || !TEST_FILE_PATTERN.test(file) || file.includes("/../") || file.includes("//")) {
      throw new Error(`refusing test path outside the allowed shape: ${JSON.stringify(file)}`);
    }
  }
  return files;
}

export function integrationFlags({ mode, changed, selected, postgresqlSelected }) {
  const full = mode === "full";
  const selectedSet = new Set(selected);
  return {
    postgresql: full
      || postgresqlSelected.length > 0
      || changed.some((path) => POSTGRESQL_PATH_PATTERNS.some((pattern) => pattern.test(path))),
    systemd: full || SYSTEMD_TEST_FILES.some((file) => selectedSet.has(file)),
    launchd: full || LAUNCHD_TEST_FILES.some((file) => selectedSet.has(file)),
  };
}

export function placeholderMatrix() {
  return { include: [{ name: "none", runner: RUNNERS.small, projects: "[]", files: "[]" }] };
}

// GitHub Actions matrix values are scalars; the composite action parses the
// JSON strings back into arrays.
export function shardMatrix(shards) {
  if (shards.length === 0) return placeholderMatrix();
  return {
    include: shards.map((shard) => ({
      name: shard.name,
      runner: shard.runner,
      projects: JSON.stringify(shard.projects),
      files: JSON.stringify(shard.files),
    })),
  };
}

// Pure planning step. `listed` is the Vitest listing for the mode (all files
// or the changed-related files); `allListed` is the complete listing used to
// resolve always-run files to their projects.
export function createPlan({ event, ref, changed, classification, listed, allListed, postgresqlSelected }) {
  const fullCoverage = event === "push" && FULL_COVERAGE_REFS.includes(ref);
  const mode = event === "push" || classification === undefined ? "full" : classification.mode;
  const byFile = new Map(allListed.map((entry) => [entry.file, entry]));
  const chosen = new Map();
  if (mode === "full") {
    for (const entry of allListed) chosen.set(entry.file, entry);
  } else {
    for (const entry of listed) chosen.set(entry.file, entry);
    for (const file of classification.alwaysRun) {
      const entry = byFile.get(file);
      if (entry === undefined) throw new Error(`always-run test file is not part of the suite: ${file}`);
      chosen.set(file, entry);
    }
  }
  const selected = assertTestFiles([...chosen.keys()].sort());
  const shards = assignShards([...chosen.values()]);
  const flags = integrationFlags({ mode, changed, selected, postgresqlSelected });
  return {
    event,
    ref,
    mode,
    reason: mode === "full" ? (event === "push" ? `push to ${ref}` : classification?.reason ?? "no diff base") : undefined,
    coverage: fullCoverage,
    changed: [...changed],
    selected,
    unit: shards.length > 0,
    shards,
    expectedFileCount: selected.length,
    ...flags,
  };
}

export function githubOutputs(plan) {
  return [
    `mode=${plan.mode}`,
    `coverage=${plan.coverage}`,
    `unit=${plan.unit}`,
    `postgresql=${plan.postgresql}`,
    `systemd=${plan.systemd}`,
    `launchd=${plan.launchd}`,
    `expected-file-count=${plan.expectedFileCount}`,
    `shards=${JSON.stringify(shardMatrix(plan.shards))}`,
  ];
}

function displayPath(path) {
  return path.replace(/[^A-Za-z0-9_./ @-]/gu, "?");
}

export function renderSummary(plan) {
  const lines = [
    "## CI plan",
    "",
    `- Event: \`${plan.event}\` on \`${displayPath(plan.ref ?? "")}\``,
    `- Mode: **${plan.mode}**${plan.reason ? ` (${displayPath(plan.reason)})` : ""}`,
    `- Coverage gate: ${plan.coverage ? "yes, merged report must reach 100% per file" : "no"}`,
    `- Changed paths: ${plan.changed.length}`,
    `- Test files: ${plan.expectedFileCount}`,
    `- PostgreSQL conformance: ${plan.postgresql ? "run" : "skip"}`,
    `- Linux user-systemd integration: ${plan.systemd ? "run" : "skip"}`,
    `- macOS launchd integration: ${plan.launchd ? "run" : "skip"}`,
    "",
    "| Shard | Runner | Projects | Files |",
    "| --- | --- | --- | ---: |",
  ];
  for (const shard of plan.shards) {
    lines.push(`| ${shard.name} | ${shard.runner} | ${shard.projects.join(", ")} | ${shard.files.length} |`);
  }
  for (const name of SHARD_NAMES) {
    if (!plan.shards.some((shard) => shard.name === name)) lines.push(`| ${name} | - | - | 0 |`);
  }
  if (plan.mode === "selective") {
    lines.push("", "<details><summary>Changed paths</summary>", "");
    for (const path of plan.changed) lines.push(`- \`${displayPath(path)}\``);
    lines.push("", "</details>", "", "<details><summary>Selected test files</summary>", "");
    for (const file of plan.selected) lines.push(`- \`${file}\``);
    lines.push("", "</details>");
  }
  return lines.join("\n") + "\n";
}

// --- process boundary -------------------------------------------------------

export function runGit(args, cwd = repositoryRoot) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

export function changedPaths(baseSha, headSha, git = runGit) {
  if (!SHA_PATTERN.test(baseSha) || !SHA_PATTERN.test(headSha)) {
    throw new Error("base and head must be full commit SHAs");
  }
  const mergeBase = git(["merge-base", baseSha, headSha]).trim();
  if (!SHA_PATTERN.test(mergeBase)) throw new Error("git merge-base did not return a commit");
  const output = git(["diff", "--name-only", "--no-renames", "-z", mergeBase, headSha]);
  const changed = output.split("\0").filter((path) => path.length > 0).sort();
  return { mergeBase, changed };
}

export function parseListing(json, root = repositoryRoot) {
  const entries = JSON.parse(json);
  if (!Array.isArray(entries)) throw new Error("vitest list did not return an array");
  return entries.map((entry) => {
    if (typeof entry?.file !== "string") throw new Error("vitest list entry without file");
    if (entry.projectName !== undefined && typeof entry.projectName !== "string") {
      throw new Error("vitest list entry with a non-string projectName");
    }
    const file = isAbsolute(entry.file) ? relative(root, entry.file).split("\\").join("/") : entry.file;
    // Single-project configurations (the PostgreSQL harness) omit the name.
    return { file, projectName: entry.projectName ?? "" };
  }).sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
}

export function listTests({ config, changedSince, run = runProcess }) {
  // `--json` takes an optional value: a bare `--json` swallows the next
  // argument as its output path and `--json=true` writes a file named
  // `true`. Always pass an explicit private output file.
  const scratch = mkdtempSync(join(tmpdir(), "lcm-ci-plan-"));
  try {
    const output = join(scratch, "listing.json");
    const args = ["node_modules/vitest/vitest.mjs", "list", "--filesOnly", "--json", output];
    if (config === undefined) args.push("--dir", "test");
    else args.push("--config", config);
    if (changedSince !== undefined) args.push("--changed", changedSince);
    run(process.execPath, args);
    return parseListing(readFileSync(output, "utf8"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function runProcess(command, args) {
  // A parent Vitest run (the planner's own tests) exports its artifact root;
  // the nested listing must not inherit it because the root must be fresh.
  const { LCM_TEST_ARTIFACT_ROOT: _inherited, ...env } = process.env;
  return execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${key}`);
    options[key.slice(2)] = value;
  }
  return options;
}

export function plan(options, dependencies = {}) {
  const list = dependencies.listTests ?? listTests;
  const diff = dependencies.changedPaths ?? changedPaths;
  const { event, ref } = options;
  if (typeof event !== "string" || event.length === 0) throw new Error("--event is required");
  const allListed = list({});
  if (event === "pull_request" || event === "merge_group") {
    const { mergeBase, changed } = diff(options.base, options.head);
    const classification = classifyChanges(changed);
    if (classification.mode === "full") {
      return createPlan({ event, ref, changed, classification, listed: allListed, allListed, postgresqlSelected: [] });
    }
    const listed = list({ changedSince: mergeBase });
    const postgresqlSelected = list({ config: "vitest.postgresql.config.ts", changedSince: mergeBase });
    return createPlan({ event, ref, changed, classification, listed, allListed, postgresqlSelected: postgresqlSelected.map((entry) => entry.file) });
  }
  return createPlan({ event, ref, changed: [], classification: undefined, listed: allListed, allListed, postgresqlSelected: [] });
}

export function main(argv = process.argv.slice(2), environment = process.env, dependencies = {}) {
  const options = parseArguments(argv);
  const result = plan(options, dependencies);
  const outputs = githubOutputs(result);
  const summary = renderSummary(result);
  if (environment.GITHUB_OUTPUT) appendFileSync(environment.GITHUB_OUTPUT, outputs.join("\n") + "\n");
  if (environment.GITHUB_STEP_SUMMARY) appendFileSync(environment.GITHUB_STEP_SUMMARY, summary);
  return { plan: result, outputs, summary };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { summary } = main();
    process.stdout.write(summary);
  } catch (error) {
    process.stderr.write(`ci-plan: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
