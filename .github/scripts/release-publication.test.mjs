import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkMergeQueuePolicy } from "./check-merge-queue-policy.mjs";
import { assertMergeQueueUsesMerge } from "./merge-queue-policy.mjs";
import { publishNpmTarball } from "./publish-npm-tarball.mjs";

const appliedQueueRule = (mergeMethod = "MERGE", overrides = {}) => ({
  type: "merge_queue",
  parameters: { merge_method: mergeMethod },
  ruleset_id: 42,
  ...overrides,
});

test("requires every queue applied to the authoritative default branch to use MERGE", () => {
  assert.deepEqual(
    assertMergeQueueUsesMerge([
      appliedQueueRule(),
      { type: "required_signatures", ruleset_id: 42 },
    ]),
    { queueCount: 1 },
  );
  assert.throws(() => assertMergeQueueUsesMerge([]), /No merge-queue rule applies/u);
  assert.throws(
    () => assertMergeQueueUsesMerge([appliedQueueRule("SQUASH")]),
    /default branch must use MERGE/u,
  );
  assert.throws(
    () => assertMergeQueueUsesMerge([null]),
    /response was malformed/u,
  );
  assert.throws(() => assertMergeQueueUsesMerge(null), /must be an array/u);
});

test("paginates ruleset inventory and validates only rules applied to the default branch", () => {
  const calls = [];
  const request = (args) => {
    calls.push(args);
    const endpoint = args.at(-1);
    if (endpoint === "repos/donadiosolutions/lcm") {
      return { default_branch: "main" };
    }
    if (endpoint.includes("?includes_parents")) {
      return [
        [
          { id: 42, target: "branch", enforcement: "active", name: "renamable" },
          { id: 99, target: "branch", enforcement: "active", name: "unrelated squash queue" },
          { id: 44, target: "tag", enforcement: "active" },
        ],
        [{ id: 43, target: "branch", enforcement: "disabled" }],
      ];
    }
    assert.equal(endpoint, "repos/donadiosolutions/lcm/rules/branches/main");
    return [appliedQueueRule()];
  };
  assert.deepEqual(
    checkMergeQueuePolicy({ repository: "donadiosolutions/lcm", request }),
    { queueCount: 1 },
  );
  assert.ok(calls[1].includes("--paginate"));
  assert.ok(calls[1].includes("--slurp"));
  assert.equal(calls.length, 3);

  assert.throws(
    () => checkMergeQueuePolicy({ repository: "not a repo", request }),
    /canonical owner\/repository/u,
  );
  assert.throws(
    () =>
      checkMergeQueuePolicy({
        repository: "donadiosolutions/lcm",
        request: (args) =>
          args.at(-1) === "repos/donadiosolutions/lcm"
            ? { default_branch: "main" }
            : { bad: true },
      }),
    /paginated.*malformed/u,
  );
  assert.throws(
    () =>
      checkMergeQueuePolicy({
        repository: "donadiosolutions/lcm",
        request: (args) => {
          const endpoint = args.at(-1);
          if (endpoint === "repos/donadiosolutions/lcm") return { default_branch: "main" };
          if (endpoint.includes("?includes_parents")) {
            return [[{ id: "bad", target: "branch", enforcement: "active" }]];
          }
          return [appliedQueueRule()];
        },
      }),
    /invalid identifier/u,
  );
  assert.throws(
    () =>
      checkMergeQueuePolicy({
        repository: "donadiosolutions/lcm",
        request: (args) => {
          const endpoint = args.at(-1);
          if (endpoint === "repos/donadiosolutions/lcm") return { default_branch: "main" };
          if (endpoint.includes("?includes_parents")) return [[{ id: 7, target: "branch", enforcement: "active" }]];
          return [appliedQueueRule()];
        },
      }),
    /did not match an active branch ruleset/u,
  );
  assert.throws(
    () =>
      checkMergeQueuePolicy({
        repository: "donadiosolutions/lcm",
        request: (args) =>
          args.at(-1) === "repos/donadiosolutions/lcm"
            ? { default_branch: "\u0000main" }
            : [],
      }),
    /invalid default branch/u,
  );
});

test("relative CLI invocation queries and rejects invalid live policy", () => {
  const root = mkdtempSync(join(tmpdir(), "lcm-release-policy-cli-"));
  const bin = join(root, "bin");
  const calls = join(root, "calls");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const endpoint = process.argv.at(-1);
appendFileSync(process.env.LCM_GH_CALLS, \`\${endpoint}\\n\`);
if (endpoint === "repos/donadiosolutions/lcm") {
  console.log('{"default_branch":"main"}');
} else if (endpoint.includes("?includes_parents")) {
  console.log('[[{"id":42,"target":"branch","enforcement":"active"}]]');
} else if (endpoint === "repos/donadiosolutions/lcm/rules/branches/main") {
  console.log('[{"type":"merge_queue","ruleset_id":42,"parameters":{"merge_method":"SQUASH"}}]');
} else {
  process.exitCode = 2;
}
`,
  );
  chmodSync(join(bin, "gh"), 0o755);

  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const result = spawnSync(
    process.execPath,
    [".github/scripts/check-merge-queue-policy.mjs"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "donadiosolutions/lcm",
        LCM_GH_CALLS: calls,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      },
      shell: false,
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /default branch must use MERGE/u);
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
    "repos/donadiosolutions/lcm",
    "repos/donadiosolutions/lcm/rulesets?includes_parents=true&per_page=100",
    "repos/donadiosolutions/lcm/rules/branches/main",
  ]);
});

test("publishes exactly one regular tarball through its absolute filesystem path", () => {
  const root = mkdtempSync(join(tmpdir(), "lcm-release-path-"));
  const fixture = join(root, "stub");
  const artifacts = join(root, "artifacts");
  mkdirSync(fixture);
  mkdirSync(artifacts);
  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({ name: "lcm-release-path-stub", version: "1.0.0" }),
  );
  const packed = spawnSync(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", artifacts],
    { cwd: fixture, encoding: "utf8", shell: false },
  );
  assert.equal(packed.status, 0, packed.stderr);

  let invokedArgs;
  const result = publishNpmTarball({
    artifactDirectory: artifacts,
    tag: "latest",
    runNpm: (args) => {
      invokedArgs = args;
      return spawnSync("npm", [...args, "--dry-run", "--json"], {
        cwd: root,
        encoding: "utf8",
        shell: false,
      });
    },
  });
  assert.equal(result.tag, "latest");
  assert.equal(isAbsolute(result.tarball), true);
  assert.equal(invokedArgs[0], "publish");
  assert.equal(invokedArgs[1], result.tarball);
  assert.equal(basename(result.tarball), "lcm-release-path-stub-1.0.0.tgz");
});

test("rejects ambiguous artifacts, non-files, invalid tags, and npm failures", () => {
  const root = mkdtempSync(join(tmpdir(), "lcm-release-invalid-"));
  assert.throws(
    () => publishNpmTarball({ artifactDirectory: root, tag: "latest" }),
    /exactly one regular npm tarball, found 0/u,
  );
  writeFileSync(join(root, "one.tgz"), "one");
  symlinkSync(join(root, "one.tgz"), join(root, "ignored-link.tgz"));
  assert.throws(
    () => publishNpmTarball({ artifactDirectory: root, tag: "next" }),
    /tag must be beta or latest/u,
  );
  writeFileSync(join(root, "two.tgz"), "two");
  assert.throws(
    () => publishNpmTarball({ artifactDirectory: root, tag: "beta" }),
    /found 2/u,
  );

  const single = mkdtempSync(join(tmpdir(), "lcm-release-failure-"));
  writeFileSync(join(single, "only.tgz"), "package");
  for (const [result, expected] of [
    [null, /npm publish failed$/u],
    [{ error: new Error("secret") }, /failed to start/u],
    [{ signal: "SIGTERM", status: null }, /was terminated/u],
    [{ status: 1 }, /npm publish failed$/u],
  ]) {
    assert.throws(
      () => publishNpmTarball({ artifactDirectory: single, tag: "latest", runNpm: () => result }),
      expected,
    );
  }
});
