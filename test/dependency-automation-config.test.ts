import { existsSync, readFileSync } from "node:fs";
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

type RenovateCustomManager = {
  customType?: unknown;
  datasourceTemplate?: unknown;
  managerFilePatterns?: unknown;
  matchStrings?: unknown;
};

type RenovatePackageRule = {
  description?: unknown;
  enabled?: unknown;
  groupName?: unknown;
  matchDatasources?: unknown;
  matchManagers?: unknown;
  matchPackageNames?: unknown;
  matchUpdateTypes?: unknown;
};

type RenovateConfig = {
  "github-actions"?: {
    managerFilePatterns?: unknown;
  };
  automerge?: unknown;
  customManagers?: RenovateCustomManager[];
  enabledManagers?: unknown;
  includePaths?: unknown;
  labels?: unknown;
  minimumReleaseAge?: unknown;
  packageRules?: RenovatePackageRule[];
  pinDigests?: unknown;
  semanticCommitScope?: unknown;
  semanticCommitType?: unknown;
  semanticCommits?: unknown;
  separateMajorMinor?: unknown;
  [key: string]: unknown;
};

const dependabotSource = readFileSync(
  new URL("../.github/dependabot.yml", import.meta.url),
  "utf8",
);
const dependabot = loadYaml(dependabotSource) as DependabotConfig;

const renovatePath = new URL("../renovate.json", import.meta.url);
const renovateExists = existsSync(renovatePath);
const renovateSource = renovateExists ? readFileSync(renovatePath, "utf8") : "{}";
const renovate = JSON.parse(renovateSource) as RenovateConfig;

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

function normalizedVersionHolds(update: DependabotUpdate): Array<{
  dependencyName: unknown;
  versions: unknown;
}> {
  return (update.ignore ?? [])
    .map((ignore) => ({
      dependencyName: ignore["dependency-name"],
      versions: ignore.versions,
    }))
    .sort(({ dependencyName: left }, { dependencyName: right }) =>
      String(left).localeCompare(String(right)),
    );
}

function configurationKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(configurationKeys);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...configurationKeys(nested)]);
}

function regexPatterns(value: unknown): RegExp[] {
  if (!Array.isArray(value)) return [];
  return value.map((pattern) => {
    if (typeof pattern !== "string" || !pattern.startsWith("/") || !pattern.endsWith("/")) {
      throw new Error(`Expected Renovate regex pattern, received ${String(pattern)}`);
    }
    return new RegExp(pattern.slice(1, -1), "u");
  });
}

// Renovate merges a manager's configured `managerFilePatterns` into that
// manager's built-in defaults: configured patterns are additive and cannot
// replace the defaults. Modelling only the configured patterns therefore
// understates which files hosted Renovate can claim. These are the
// `github-actions` built-ins read from
// dist/modules/manager/github-actions/index.js, verified byte-identical in the
// installed 44.35.3 bundle and the published 44.97.4 bundle on 2026-09-17, so
// this expectation is stable across that version gap.
const GITHUB_ACTIONS_BUILT_IN_PATTERNS = [
  "/(^|/)(workflow-templates|\\.(?:github|gitea|forgejo)/(?:workflows|actions))/.+\\.ya?ml$/",
  "/(^|/)action\\.ya?ml$/",
];

/** Managers whose merged built-in and configured patterns match `fileName`. */
function matchingManagers(fileName: string): string[] {
  const configured = renovate["github-actions"]?.managerFilePatterns;
  const githubActionsPatterns = regexPatterns([
    ...GITHUB_ACTIONS_BUILT_IN_PATTERNS,
    ...(Array.isArray(configured) ? configured : []),
  ]);
  const githubActionsMatches = githubActionsPatterns.some((pattern) => pattern.test(fileName));
  const customRegexMatches = (renovate.customManagers ?? []).some((manager) =>
    regexPatterns(manager.managerFilePatterns).some((pattern) => pattern.test(fileName)),
  );

  return [
    ...(githubActionsMatches ? ["github-actions"] : []),
    ...(customRegexMatches ? ["custom.regex"] : []),
  ];
}

// Renovate matches `includePaths` with minimatch. This helper implements only
// the two pattern shapes the repository actually uses: a literal path, and a
// literal directory followed by `/**`. Any other shape refuses loudly rather
// than silently reporting no owner, because a quiet wrong answer here is the
// exact failure this test was fixed to remove.
const GLOB_METACHARACTERS = /[*?[\]{}()!+@|]/u;

/** Whether `includePaths` admits `fileName` before any manager can claim it. */
function includedByPaths(
  fileName: string,
  paths: unknown = renovate.includePaths,
): boolean {
  if (!Array.isArray(paths)) return false;
  return paths.some((pattern) => {
    if (typeof pattern !== "string") {
      throw new Error(`Expected a Renovate includePaths string, received ${String(pattern)}`);
    }
    const directoryPrefix = pattern.endsWith("/**") ? pattern.slice(0, -3) : undefined;
    if (GLOB_METACHARACTERS.test(directoryPrefix ?? pattern)) {
      throw new Error(
        `Unmodelled Renovate includePaths pattern ${pattern}: this helper implements `
          + "only a literal path or a literal directory followed by /**",
      );
    }
    return directoryPrefix === undefined
      ? fileName === pattern
      : fileName.startsWith(`${directoryPrefix}/`);
  });
}

/** Managers hosted Renovate effectively assigns, after `includePaths` filtering. */
function effectiveOwners(fileName: string): string[] {
  return includedByPaths(fileName) ? matchingManagers(fileName) : [];
}

function postgresqlImageMatches(source: string): Array<Record<string, string | undefined>> {
  const manager = (renovate.customManagers ?? []).find(
    (candidate) => candidate.customType === "regex",
  );
  const matchString = manager?.matchStrings;
  if (!Array.isArray(matchString) || typeof matchString[0] !== "string") return [];

  return [...source.matchAll(new RegExp(matchString[0], "gmu"))].map((match) => match.groups ?? {});
}

function expectCompletePostgresqlImageMatches(
  matches: Array<Record<string, string | undefined>>,
): void {
  expect(matches).toHaveLength(2);
  expect(matches.map(({ depName }) => depName).sort()).toEqual(["node", "postgres"]);
  for (const { currentDigest, currentValue } of matches) {
    expect(currentValue).toMatch(/^[^\s@"]+$/u);
    expect(currentDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  }
}

describe("dependency automation configuration", () => {
  it("partitions routine npm updates while preserving coupled Vitest releases", () => {
    const npm = updateFor("npm");
    const routine = groupFor(npm, "npm-routine");
    const vitest = groupFor(npm, "vitest-routine");

    expect(Object.keys(npm.groups ?? {}).sort()).toEqual(["npm-routine", "vitest-routine"]);
    expect(routine.patterns).toEqual(["*"]);
    expect(routine["exclude-patterns"]).toEqual(["vitest", "@vitest/coverage-v8"]);
    expectMinorPatchOnly(routine);

    expect(vitest.patterns).toEqual(["vitest", "@vitest/coverage-v8"]);
    expectMinorPatchOnly(vitest);
  });

  it("holds only explicitly incompatible npm major ranges until their stated conditions are met", () => {
    const npm = updateFor("npm");

    expect(normalizedVersionHolds(npm)).toEqual([
      { dependencyName: "@vitest/coverage-v8", versions: [">=5.0.0"] },
      { dependencyName: "typescript", versions: [">=7.0.0"] },
      { dependencyName: "vitest", versions: [">=5.0.0"] },
    ]);
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

    expect(Object.keys(actions.groups ?? {}).sort()).toEqual(["github-actions-routine"]);
    expect(routine.patterns).toEqual(["*"]);
    expectMinorPatchOnly(routine);
    expect(normalizedVersionHolds(actions)).toEqual([
      { dependencyName: "changesets/action", versions: [">=2.0.0"] },
    ]);
    expect(dependabotSource).toMatch(
      /# Remove when changesets\/action 2 passes this repository's protected version-PR workflow validation\./u,
    );
  });

  it("keeps Dependabot pull requests human-reviewed by omitting auto-merge configuration", () => {
    expect(configurationKeys(dependabot)).not.toContain("automerge");
    expect(configurationKeys(dependabot)).not.toContain("auto-merge");
  });

  it("enables Renovate only after its reviewed configuration exists", () => {
    expect(renovateExists).toBe(true);
  });

  it.each([".github/actions/action.yml", ".github/actions/action.yaml"])(
    "assigns the root composite action %s only to the GitHub Actions manager",
    (fileName) => {
      expect(effectiveOwners(fileName)).toEqual(["github-actions"]);
    },
  );

  it.each([
    ".github/actions/action.YAML",
    ".github/actions/action.yaml.bak",
  ])("does not assign the root lookalike %s to a Renovate manager", (fileName) => {
    expect(effectiveOwners(fileName)).toEqual([]);
  });

  it("assigns nested lookalike YAML through Renovate's built-in patterns", () => {
    // The configured pattern does not match these names, but the built-in
    // `.github/actions` default does and `includePaths` admits them, so hosted
    // Renovate owns them as github-actions. Asserting no owner here would
    // describe a repository-only pattern set that Renovate never applies.
    expect(effectiveOwners(".github/actions/my-action.yaml")).toEqual(["github-actions"]);
    expect(effectiveOwners(".github/actions/example/my-action.yaml")).toEqual([
      "github-actions",
    ]);
  });

  it("gives hosted Renovate exactly one owner for each approved file family", () => {
    expect(renovate.enabledManagers).toEqual(["github-actions", "custom.regex"]);
    expect(renovate.includePaths).toEqual([
      ".github/actions/**",
      "scripts/postgresql-images.mjs",
    ]);
    expect(effectiveOwners(".github/actions/setup-ci/action.yml")).toEqual([
      "github-actions",
    ]);
    expect(effectiveOwners(".github/actions/nested/setup/action.yaml")).toEqual([
      "github-actions",
    ]);
    expect(effectiveOwners(".github/actions/example/action.YAML")).toEqual([]);
    expect(effectiveOwners(".github/actions/example/action.yaml.bak")).toEqual([]);
    expect(effectiveOwners("scripts/postgresql-images.mjs")).toEqual(["custom.regex"]);
    expect(effectiveOwners("package.json")).toEqual([]);
    expect(effectiveOwners("pnpm-lock.yaml")).toEqual([]);
  });

  it("keeps workflow files out of scope through includePaths, not manager patterns", () => {
    // The built-in github-actions pattern does match workflow YAML, so only
    // `includePaths` keeps these files out of scope. Asserting this through the
    // manager patterns alone would pass for the wrong reason.
    expect(matchingManagers(".github/workflows/ci.yml")).toEqual(["github-actions"]);
    expect(includedByPaths(".github/workflows/ci.yml")).toBe(false);
    expect(effectiveOwners(".github/workflows/ci.yml")).toEqual([]);
  });

  it("refuses an includePaths pattern shape it does not model", () => {
    // A future entry such as scripts/*.mjs must break the build rather than
    // quietly report no owner for a file hosted Renovate would include.
    expect(() => includedByPaths("scripts/postgresql-images.mjs", ["scripts/*.mjs"]))
      .toThrow(/Unmodelled Renovate includePaths pattern/u);
    expect(() => includedByPaths(".github/actions/setup/action.yml", [".github/actions/*/**"]))
      .toThrow(/Unmodelled Renovate includePaths pattern/u);
    expect(() => includedByPaths(".github/actions/action.yml", [42]))
      .toThrow(/Expected a Renovate includePaths string/u);
    // The two shapes the repository does use stay supported.
    expect(includedByPaths(".github/actions/setup-ci/action.yml", [".github/actions/**"])).toBe(true);
    expect(includedByPaths("scripts/postgresql-images.mjs", ["scripts/postgresql-images.mjs"]))
      .toBe(true);
    expect(includedByPaths(".github/workflows/ci.yml", [".github/actions/**"])).toBe(false);
  });

  it("recognizes both fully pinned PostgreSQL harness images and rejects partial tuples", () => {
    const currentImageSource = readFileSync(
      new URL("../scripts/postgresql-images.mjs", import.meta.url),
      "utf8",
    );
    const alternateImageSource = [
      'export const POSTGRES_IMAGE = "postgres:18.5-bookworm@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";',
      'export const NODE_IMAGE = "node:22.21.0-bookworm-slim@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";',
    ].join("\n");

    expect(renovate.customManagers).toHaveLength(1);
    expect(renovate.customManagers?.[0]?.customType).toBe("regex");
    expect(renovate.customManagers?.[0]?.datasourceTemplate).toBe("docker");
    expectCompletePostgresqlImageMatches(postgresqlImageMatches(currentImageSource));
    expectCompletePostgresqlImageMatches(postgresqlImageMatches(alternateImageSource));
    expect(
      postgresqlImageMatches('export const POSTGRES_IMAGE = "postgres:18.4-bookworm";'),
    ).toEqual([]);
    expect(
      postgresqlImageMatches(
        'export const POSTGRES_IMAGE = "postgres@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296";',
      ),
    ).toEqual([]);
    expect(
      postgresqlImageMatches(
        'export const POSTGRES_IMAGE = "postgres:18.4-bookworm@sha256:not-a-digest";',
      ),
    ).toEqual([]);
    expect(
      postgresqlImageMatches(
        'export const OTHER_IMAGE = "postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296";',
      ),
    ).toEqual([]);
  });

  it("preserves pins, separates majors, and requires human review for Renovate updates", () => {
    expect(renovate.automerge).toBe(false);
    expect(configurationKeys(renovate).filter((key) => key === "automerge")).toEqual([
      "automerge",
    ]);
    expect(configurationKeys(renovate)).not.toContain("auto-merge");
    expect(renovate.minimumReleaseAge).toBe("7 days");
    expect(renovate.labels).toEqual(["dependencies"]);
    expect(renovate.semanticCommits).toBe("enabled");
    expect(renovate.semanticCommitType).toBe("build");
    expect(renovate.semanticCommitScope).toBe("deps");
    expect(renovate.separateMajorMinor).toBe(true);
    expect(renovate.pinDigests).toBe(true);
  });

  it("keeps cache actions coupled and limits harness images to digest updates", () => {
    expect(renovate.packageRules).toEqual([
      {
        groupName: "actions/cache",
        matchManagers: ["github-actions"],
        matchPackageNames: ["actions/cache", "actions/cache/restore", "actions/cache/save"],
      },
      {
        description: "Refresh image digests only; tag bumps remain coupled to harness runtime policy",
        enabled: false,
        matchDatasources: ["docker"],
        matchManagers: ["custom.regex"],
        matchUpdateTypes: [
          "major",
          "minor",
          "patch",
          "pin",
          "rollback",
          "bump",
          "replacement",
        ],
      },
    ]);
  });
});
