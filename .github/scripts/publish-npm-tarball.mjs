import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function collectTarballs(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectTarballs(path);
    return entry.isFile() && entry.name.endsWith(".tgz") ? [path] : [];
  });
}

function defaultRunNpm(args) {
  return spawnSync("npm", args, {
    stdio: "inherit",
    timeout: 10 * 60_000,
    killSignal: "SIGTERM",
    shell: false,
  });
}

export function publishNpmTarball({
  artifactDirectory,
  tag,
  runNpm = defaultRunNpm,
}) {
  if (tag !== "beta" && tag !== "latest") throw new Error("npm publish tag must be beta or latest");
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
  if (result.error) throw new Error("npm publish failed to start");
  if (result.signal) throw new Error("npm publish was terminated");
  if (result.status !== 0) throw new Error("npm publish failed");
  return { tarball, tag };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [artifactDirectory, tag] = process.argv.slice(2);
  if (!artifactDirectory || !tag) {
    throw new Error("Usage: publish-npm-tarball.mjs ARTIFACT_DIRECTORY beta|latest");
  }
  publishNpmTarball({ artifactDirectory, tag });
}
