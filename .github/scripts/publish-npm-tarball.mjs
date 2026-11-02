import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReleaseTag } from "./release-tag-policy.mjs";

function collectTarballs(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectTarballs(path);
    return entry.isFile() && entry.name.endsWith(".tgz") ? [path] : [];
  });
}

function defaultRunNpm(args) {
  return spawnSync("npm", args, {
    stdio: ["inherit", "inherit", "pipe"],
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10 * 60_000,
    killSignal: "SIGTERM",
    shell: false,
  });
}

function isStagedVersionConflict(stderr, version) {
  return (
    typeof stderr === "string" &&
    /\bE409\b/u.test(stderr) &&
    stderr.includes(`Cannot publish over previously staged version "${version}"`)
  );
}

function assertCanonicalVersion(version) {
  try {
    if (typeof version === "string" && parseReleaseTag(`v${version}`).version === version) return;
  } catch {
    // Reported below without echoing the rejected value.
  }
  throw new Error("npm publish requires the canonical release version");
}

export function publishNpmTarball({
  artifactDirectory,
  tag,
  version,
  runNpm = defaultRunNpm,
  writeStderr = (chunk) => process.stderr.write(chunk),
}) {
  if (tag !== "alpha" && tag !== "beta" && tag !== "latest") {
    throw new Error("npm publish tag must be alpha, beta, or latest");
  }
  assertCanonicalVersion(version);
  const directory = resolve(artifactDirectory);
  const tarballs = collectTarballs(directory);
  if (tarballs.length !== 1) {
    throw new Error(`Expected exactly one regular npm tarball, found ${tarballs.length}`);
  }
  const tarball = resolve(tarballs[0]);
  if (!statSync(tarball).isFile() || !tarball.endsWith(".tgz")) {
    throw new Error("The npm artifact must be one regular .tgz file");
  }

  const result = runNpm([
    "publish",
    tarball,
    "--ignore-scripts",
    "--access",
    "public",
    "--tag",
    tag,
  ]);
  if (result === null || typeof result !== "object") throw new Error("npm publish failed");
  if (typeof result.stderr === "string" && result.stderr.length > 0) writeStderr(result.stderr);
  if (result.error) throw new Error("npm publish failed to start");
  if (result.signal) throw new Error("npm publish was terminated");
  if (result.status !== 0 && isStagedVersionConflict(result.stderr, version)) {
    return { tarball, tag, staged: true };
  }
  if (result.status !== 0) throw new Error("npm publish failed");
  return { tarball, tag, staged: false };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [artifactDirectory, tag, version] = process.argv.slice(2);
  if (!artifactDirectory || !tag || !version) {
    throw new Error(
      "Usage: publish-npm-tarball.mjs ARTIFACT_DIRECTORY alpha|beta|latest VERSION",
    );
  }
  const { staged } = publishNpmTarball({ artifactDirectory, tag, version });
  if (staged) {
    console.log(
      `::notice::npm already staged ${version}; skipping the duplicate upload and verifying`,
    );
  }
}
