import { readFileSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

type DependabotGroup = {
  patterns?: unknown;
  "exclude-patterns"?: unknown;
  "update-types"?: unknown;
};

type DependabotIgnore = {
  "dependency-name"?: unknown;
  versions?: unknown;
};

type DependabotUpdate = {
  "package-ecosystem"?: unknown;
  groups?: Record<string, DependabotGroup>;
  ignore?: DependabotIgnore[];
  [key: string]: unknown;
};

type DependabotConfig = {
  version?: unknown;
  updates?: DependabotUpdate[];
};

const dependabotSource = readFileSync(
  new URL("../.github/dependabot.yml", import.meta.url),
  "utf8",
);
const dependabot = loadYaml(dependabotSource) as DependabotConfig;

function updateFor(ecosystem: string): DependabotUpdate {
  const update = dependabot.updates?.find(
    (candidate) => candidate["package-ecosystem"] === ecosystem,
  );
  if (!update) throw new Error(`Missing Dependabot update configuration for ${ecosystem}`);
  return update;
}

function groupFor(update: DependabotUpdate, name: string): DependabotGroup {
  const group = update.groups?.[name];
  if (!group) throw new Error(`Missing Dependabot group ${name}`);
  return group;
}

function expectMinorPatchOnly(group: DependabotGroup): void {
  expect(group["update-types"]).toEqual(["minor", "patch"]);
}

function expectVersionHold(
  update: DependabotUpdate,
  dependencyName: string,
  versionRange: string,
): void {
  expect(update.ignore).toContainEqual({
    "dependency-name": dependencyName,
    versions: [versionRange],
  });
}

function configurationKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(configurationKeys);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...configurationKeys(nested)]);
}

describe("dependency automation configuration", () => {
  it("partitions routine npm updates while preserving coupled Vitest releases", () => {
    const npm = updateFor("npm");
    const routine = groupFor(npm, "npm-routine");
    const vitest = groupFor(npm, "vitest-routine");

    expect(routine.patterns).toEqual(["*"]);
    expect(routine["exclude-patterns"]).toEqual(["vitest", "@vitest/coverage-v8"]);
    expectMinorPatchOnly(routine);

    expect(vitest.patterns).toEqual(["vitest", "@vitest/coverage-v8"]);
    expectMinorPatchOnly(vitest);
  });

  it("holds only explicitly incompatible npm major ranges until their stated conditions are met", () => {
    const npm = updateFor("npm");

    expectVersionHold(npm, "typescript", ">=7.0.0");
    expectVersionHold(npm, "vitest", ">=5.0.0");
    expectVersionHold(npm, "@vitest/coverage-v8", ">=5.0.0");
    expect(dependabotSource).toMatch(
      /# Remove when typescript-eslint's supported TypeScript peer range includes 7\./u,
    );
    expect(dependabotSource).toMatch(
      /# Remove when Vitest 5 and its V8 coverage package pass this repository's compatibility suite\./u,
    );
    expect(dependabotSource).toMatch(
      /# Remove when Vitest 5's V8 coverage package passes this repository's compatibility suite with Vitest\./u,
    );
  });

  it("groups GitHub Action routine releases and holds only the unvalidated changesets action major", () => {
    const actions = updateFor("github-actions");
    const routine = groupFor(actions, "github-actions-routine");

    expect(routine.patterns).toEqual(["*"]);
    expectMinorPatchOnly(routine);
    expectVersionHold(actions, "changesets/action", ">=2.0.0");
    expect(dependabotSource).toMatch(
      /# Remove when changesets\/action 2 passes this repository's protected version-PR workflow validation\./u,
    );
  });

  it("keeps Dependabot pull requests human-reviewed by omitting auto-merge configuration", () => {
    expect(configurationKeys(dependabot)).not.toContain("automerge");
    expect(configurationKeys(dependabot)).not.toContain("auto-merge");
  });
});
