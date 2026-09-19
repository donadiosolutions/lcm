// CI shard registry: the single source of truth for how the Vitest suite is
// split across GitHub Actions runners. `scripts/ci-plan.mjs` distributes the
// selected test files over these shards; `.github/actions/vitest-shard`
// executes exactly one entry. Every Vitest project in `vitest.config.ts` is
// owned by exactly one shard group, and the contract test in
// `test/scripts/ci-test-shards.test.ts` enforces that.

export const RUNNERS = Object.freeze({
  small: "blacksmith-4vcpu-ubuntu-2404",
  large: "blacksmith-8vcpu-ubuntu-2404",
});

export const PORTABLE_STREAM_FILES = Object.freeze([
  "test/storage/portable-record-stream.test.ts",
]);

// Approximate wall-clock seconds measured on the 8 vCPU runner. Files absent
// from this table weigh `DEFAULT_FILE_WEIGHT`. The weights only balance the
// parallel pool between its two shards; exactness is not required.
export const FILE_WEIGHTS = Object.freeze({
  "test/migration/batch-copy.test.ts": 36,
  "test/storage/portable-record-parity.test.ts": 34,
  "test/storage/sqlite-portable-receipts.test.ts": 25,
  "test/external-admission-workflow.test.ts": 20,
  "test/storage/postgresql-portable-destination.test.ts": 13,
  "test/daemon/supervisor.test.ts": 13,
  "test/scripts/release-helper.test.ts": 9,
  "test/llm/codex-process.test.ts": 9,
  "test/daemon/coverage-400-supervisor.test.ts": 9,
  "test/timezone-fixture-runner.test.ts": 6,
  "test/storage/sqlite-project-storage.test.ts": 6,
  "test/migration/queue-evidence.test.ts": 5,
  "test/migration/maintenance.test.ts": 5,
  "test/physical-lifecycle-process.test.ts": 5,
  "test/identity-service.test.ts": 4,
  "test/migration/sqlite-snapshot.test.ts": 4,
  "test/llm/claude-process.test.ts": 4,
  "test/backend-publication.test.ts": 4,
  "test/batch-compact.test.ts": 4,
});
export const DEFAULT_FILE_WEIGHT = 1;
export const UNIT_PARALLEL_SHARD_COUNT = 2;

// Shard groups. `projects` are Vitest project names; `partition` decides which
// files of those projects belong to the group when several groups share one
// project; `split` fans one group out over several runners.
export const SHARD_GROUPS = Object.freeze([
  Object.freeze({
    name: "unit",
    runner: RUNNERS.large,
    projects: Object.freeze(["unit-parallel"]),
    split: UNIT_PARALLEL_SHARD_COUNT,
  }),
  Object.freeze({
    name: "portable-stream",
    runner: RUNNERS.small,
    projects: Object.freeze(["unit-portable-boundaries"]),
    partition: (file) => PORTABLE_STREAM_FILES.includes(file),
  }),
  Object.freeze({
    name: "portable-sqlite",
    runner: RUNNERS.small,
    projects: Object.freeze(["unit-portable-boundaries"]),
    partition: (file) => !PORTABLE_STREAM_FILES.includes(file),
  }),
  Object.freeze({
    name: "serial",
    runner: RUNNERS.small,
    projects: Object.freeze(["unit-package", "unit-sqlite-routes", "e2e"]),
  }),
]);

export const SHARD_NAMES = Object.freeze(SHARD_GROUPS.flatMap((group) =>
  group.split === undefined
    ? [group.name]
    : Array.from({ length: group.split }, (_, index) => `${group.name}-${index + 1}`),
));

export const VITEST_PROJECTS = Object.freeze([
  "unit-parallel",
  "unit-portable-boundaries",
  "unit-package",
  "unit-sqlite-routes",
  "e2e",
]);

export function fileWeight(file) {
  return FILE_WEIGHTS[file] ?? DEFAULT_FILE_WEIGHT;
}

// Longest-processing-time first: heaviest files are placed on the currently
// lightest bin. Deterministic for identical inputs.
export function balanceFiles(files, binCount) {
  const bins = Array.from({ length: binCount }, () => ({ weight: 0, files: [] }));
  const ordered = [...files].sort((left, right) =>
    fileWeight(right) - fileWeight(left) || (left < right ? -1 : left > right ? 1 : 0));
  for (const file of ordered) {
    const target = bins.reduce((lightest, bin) => (bin.weight < lightest.weight ? bin : lightest));
    target.weight += fileWeight(file);
    target.files.push(file);
  }
  return bins.map((bin) => bin.files.sort());
}

// `listed` is the output of `vitest list --filesOnly --json=true`, one entry per
// test file with its Vitest project name, using repository-relative paths.
// Returns the GitHub Actions matrix entries; shards without files are dropped.
export function assignShards(listed) {
  const entries = [];
  const claimed = new Set();
  for (const group of SHARD_GROUPS) {
    const files = listed
      .filter((entry) => group.projects.includes(entry.projectName))
      .filter((entry) => group.partition === undefined || group.partition(entry.file))
      .map((entry) => entry.file);
    for (const file of files) {
      if (claimed.has(file)) throw new Error(`test file assigned to two shards: ${file}`);
      claimed.add(file);
    }
    const bins = group.split === undefined ? [files.sort()] : balanceFiles(files, group.split);
    bins.forEach((binFiles, index) => {
      if (binFiles.length === 0) return;
      entries.push({
        name: group.split === undefined ? group.name : `${group.name}-${index + 1}`,
        runner: group.runner,
        projects: [...group.projects],
        files: binFiles,
      });
    });
  }
  const unclaimed = listed.filter((entry) => !claimed.has(entry.file));
  if (unclaimed.length > 0) {
    throw new Error(`test files without a shard: ${unclaimed.map((entry) => `${entry.file} [${entry.projectName}]`).join(", ")}`);
  }
  return entries;
}
