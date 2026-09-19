import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILE_WEIGHT,
  FILE_WEIGHTS,
  PORTABLE_STREAM_FILES,
  RUNNERS,
  SHARD_GROUPS,
  SHARD_NAMES,
  UNIT_PARALLEL_SHARD_COUNT,
  VITEST_PROJECTS,
  assignShards,
  balanceFiles,
  fileWeight,
} from "../../scripts/ci-test-shards.mjs";
import { createVitestConfiguration } from "../../vitest.config";

interface Listed {
  file: string;
  projectName: string;
}

const repositoryRoot = new URL("../../", import.meta.url);

function listing(entries: Array<[string, string]>): Listed[] {
  return entries.map(([file, projectName]) => ({ file, projectName }));
}

describe("CI shard registry", () => {
  it("names every Vitest project from vitest.config.ts exactly once", () => {
    const configuration = createVitestConfiguration("/tmp/ci-shards-config-only", { CI: "true" });
    const projects = (configuration.test?.projects ?? []).map((project) =>
      (project as { test: { name: string } }).test.name);
    expect([...projects].sort()).toEqual([...VITEST_PROJECTS].sort());
    const owned = SHARD_GROUPS.flatMap((group) => group.projects);
    expect([...new Set(owned)].sort()).toEqual([...VITEST_PROJECTS].sort());
    // A project shared by several groups must be partitioned by every one of them.
    for (const project of VITEST_PROJECTS) {
      const owners = SHARD_GROUPS.filter((group) => group.projects.includes(project));
      if (owners.length > 1) {
        expect(owners.every((group) => typeof group.partition === "function")).toBe(true);
      }
    }
  });

  it("keeps the serial projects and the boundary files on small runners and the parallel pool on large ones", () => {
    expect(RUNNERS).toEqual({
      small: "blacksmith-4vcpu-ubuntu-2404",
      large: "blacksmith-8vcpu-ubuntu-2404",
    });
    expect(SHARD_NAMES).toEqual(["unit-1", "unit-2", "portable-stream", "portable-sqlite", "serial"]);
    expect(UNIT_PARALLEL_SHARD_COUNT).toBe(2);
    for (const group of SHARD_GROUPS) {
      expect(group.runner).toBe(group.name === "unit" ? RUNNERS.large : RUNNERS.small);
    }
    const configuration = createVitestConfiguration("/tmp/ci-shards-config-only", { CI: "true" });
    const boundaries = (configuration.test?.projects ?? [])
      .map((project) => (project as { test: { name: string; include: string[] } }).test)
      .find((project) => project.name === "unit-portable-boundaries");
    expect(boundaries?.include).toContain(PORTABLE_STREAM_FILES[0]);
  });

  it("weights only files that exist so the balance table cannot rot", () => {
    for (const file of [...Object.keys(FILE_WEIGHTS), ...PORTABLE_STREAM_FILES]) {
      expect(existsSync(new URL(file, repositoryRoot)), file).toBe(true);
    }
    expect(fileWeight("test/migration/batch-copy.test.ts")).toBeGreaterThan(DEFAULT_FILE_WEIGHT);
    expect(fileWeight("test/unknown.test.ts")).toBe(DEFAULT_FILE_WEIGHT);
    expect(Object.values(FILE_WEIGHTS).every((weight) => weight > DEFAULT_FILE_WEIGHT)).toBe(true);
  });

  it("balances heavy files across bins deterministically and sorts every bin", () => {
    const files = [
      "test/z-light.test.ts",
      "test/migration/batch-copy.test.ts",
      "test/a-light.test.ts",
      "test/storage/portable-record-parity.test.ts",
      "test/m-light.test.ts",
    ];
    const bins = balanceFiles(files, 2);
    expect(bins).toEqual(balanceFiles([...files].reverse(), 2));
    expect(bins.flat().sort()).toEqual([...files].sort());
    const heavyBins = bins.map((bin) => bin.filter((file) => fileWeight(file) > DEFAULT_FILE_WEIGHT).length);
    expect(heavyBins).toEqual([1, 1]);
    for (const bin of bins) expect(bin).toEqual([...bin].sort());
    expect(balanceFiles([], 2)).toEqual([[], []]);
  });

  it("assigns the complete listing to the five shards", () => {
    const entries = assignShards(listing([
      ["test/b.test.ts", "unit-parallel"],
      ["test/a.test.ts", "unit-parallel"],
      ["test/migration/batch-copy.test.ts", "unit-parallel"],
      ["test/storage/portable-record-stream.test.ts", "unit-portable-boundaries"],
      ["test/storage/portable-record.test.ts", "unit-portable-boundaries"],
      ["test/storage/sqlite-portable-source.test.ts", "unit-portable-boundaries"],
      ["test/package-config.test.ts", "unit-package"],
      ["test/daemon/routes/store.test.ts", "unit-sqlite-routes"],
      ["test/e2e/harness.test.ts", "e2e"],
    ]));
    expect(entries.map((entry) => entry.name)).toEqual(SHARD_NAMES);
    expect(entries.find((entry) => entry.name === "portable-stream")).toEqual({
      name: "portable-stream",
      runner: RUNNERS.small,
      projects: ["unit-portable-boundaries"],
      files: ["test/storage/portable-record-stream.test.ts"],
    });
    expect(entries.find((entry) => entry.name === "portable-sqlite")?.files).toEqual([
      "test/storage/portable-record.test.ts",
      "test/storage/sqlite-portable-source.test.ts",
    ]);
    expect(entries.find((entry) => entry.name === "serial")).toEqual({
      name: "serial",
      runner: RUNNERS.small,
      projects: ["unit-package", "unit-sqlite-routes", "e2e"],
      files: ["test/daemon/routes/store.test.ts", "test/e2e/harness.test.ts", "test/package-config.test.ts"],
    });
    const unitFiles = entries.filter((entry) => entry.name.startsWith("unit-")).flatMap((entry) => entry.files);
    expect(unitFiles.sort()).toEqual(["test/a.test.ts", "test/b.test.ts", "test/migration/batch-copy.test.ts"]);
    expect(entries.every((entry) => entry.files.length > 0)).toBe(true);
  });

  it("drops shards without files and reports files no shard owns", () => {
    expect(assignShards(listing([["test/a.test.ts", "unit-parallel"]]))).toEqual([
      { name: "unit-1", runner: RUNNERS.large, projects: ["unit-parallel"], files: ["test/a.test.ts"] },
    ]);
    expect(assignShards([])).toEqual([]);
    expect(() => assignShards(listing([["test/a.test.ts", "browser"]]))).toThrow(/without a shard/u);
  });
});
