import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import test from "node:test";
import { publishNpmTarball } from "./publish-npm-tarball.mjs";

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
    version: "1.0.0",
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
  assert.equal(result.staged, false);
  assert.equal(isAbsolute(result.tarball), true);
  assert.equal(invokedArgs[0], "publish");
  assert.equal(invokedArgs[1], result.tarball);
  assert.equal(basename(result.tarball), "lcm-release-path-stub-1.0.0.tgz");
});

test("rejects ambiguous artifacts, non-files, invalid tags, and npm failures", () => {
  const root = mkdtempSync(join(tmpdir(), "lcm-release-invalid-"));
  const version = "1.0.0";
  assert.throws(
    () => publishNpmTarball({ artifactDirectory: root, tag: "latest", version }),
    /exactly one regular npm tarball, found 0/u,
  );
  writeFileSync(join(root, "one.tgz"), "one");
  symlinkSync(join(root, "one.tgz"), join(root, "ignored-link.tgz"));
  assert.throws(
    () => publishNpmTarball({ artifactDirectory: root, tag: "next", version }),
    /tag must be alpha, beta, or latest/u,
  );
  writeFileSync(join(root, "two.tgz"), "two");
  assert.throws(
    () => publishNpmTarball({ artifactDirectory: root, tag: "beta", version }),
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
      () =>
        publishNpmTarball({
          artifactDirectory: single,
          tag: "latest",
          version,
          runNpm: () => result,
        }),
      expected,
    );
  }
});

const STAGED_STDERR = [
  "npm error code E409",
  'npm error 409 Conflict - PUT https://registry.npmjs.org/@donadiosolutions%2flcm - Cannot publish over previously staged version "2.0.0-alpha.0".',
].join("\n");

function stagedFixture() {
  const directory = mkdtempSync(join(tmpdir(), "lcm-release-staged-"));
  writeFileSync(join(directory, "only.tgz"), "package");
  return directory;
}

test("treats an E409 previously staged response for the expected version as uploaded", () => {
  const artifactDirectory = stagedFixture();
  const forwarded = [];
  let invocations = 0;
  const result = publishNpmTarball({
    artifactDirectory,
    tag: "alpha",
    version: "2.0.0-alpha.0",
    runNpm: () => {
      invocations += 1;
      return { status: 1, stderr: STAGED_STDERR };
    },
    writeStderr: (chunk) => forwarded.push(chunk),
  });
  assert.equal(result.staged, true);
  assert.equal(result.tag, "alpha");
  assert.equal(basename(result.tarball), "only.tgz");
  assert.equal(invocations, 1);
  assert.deepEqual(forwarded, [STAGED_STDERR]);
});

test("forwards npm stderr on success and passes the unchanged publish arguments", () => {
  const artifactDirectory = stagedFixture();
  const forwarded = [];
  let invokedArgs;
  const result = publishNpmTarball({
    artifactDirectory,
    tag: "beta",
    version: "1.5.0-beta.2",
    runNpm: (args) => {
      invokedArgs = args;
      return { status: 0, stderr: "npm notice published" };
    },
    writeStderr: (chunk) => forwarded.push(chunk),
  });
  assert.equal(result.staged, false);
  assert.deepEqual(forwarded, ["npm notice published"]);
  assert.deepEqual(invokedArgs, [
    "publish",
    result.tarball,
    "--ignore-scripts",
    "--access",
    "public",
    "--tag",
    "beta",
  ]);
});

test("does not treat other npm conflicts as a staged upload", () => {
  const artifactDirectory = stagedFixture();
  for (const [stderr, version] of [
    [STAGED_STDERR, "2.0.0-alpha.1"],
    [STAGED_STDERR.replace("npm error code E409", "npm error code E400"), "2.0.0-alpha.0"],
    ["npm error code E409\nnpm error 409 Conflict - something else", "2.0.0-alpha.0"],
    [
      "npm error code E403\nnpm error You cannot publish over the previously published versions: 2.0.0-alpha.0.",
      "2.0.0-alpha.0",
    ],
    ["npm error code E409", "2.0.0-alpha.0"],
    [undefined, "2.0.0-alpha.0"],
    [Buffer.from(STAGED_STDERR), "2.0.0-alpha.0"],
  ]) {
    const forwarded = [];
    assert.throws(
      () =>
        publishNpmTarball({
          artifactDirectory,
          tag: "alpha",
          version,
          runNpm: () => ({ status: 1, stderr }),
          writeStderr: (chunk) => forwarded.push(chunk),
        }),
      /npm publish failed$/u,
    );
    assert.deepEqual(forwarded, typeof stderr === "string" ? [stderr] : []);
  }
  assert.throws(
    () =>
      publishNpmTarball({
        artifactDirectory,
        tag: "alpha",
        version: "2.0.0-alpha.0",
        runNpm: () => ({ signal: "SIGTERM", status: null, stderr: STAGED_STDERR }),
        writeStderr: () => assert.fail("terminated npm output is not interpreted"),
      }),
    /was terminated/u,
  );
});

test("requires a canonical release version before running npm", () => {
  const artifactDirectory = stagedFixture();
  for (const version of [undefined, "", "v2.0.0", "2.0", "2.0.0-rc.1", "02.0.0", 2, null]) {
    assert.throws(
      () =>
        publishNpmTarball({
          artifactDirectory,
          tag: "alpha",
          version,
          runNpm: () => assert.fail("npm must not run for an invalid version"),
        }),
      /canonical release version/u,
    );
  }
});
