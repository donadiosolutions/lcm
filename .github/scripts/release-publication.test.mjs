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
