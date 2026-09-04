import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Run this policy from the trusted checkout before executing tagged build tools.
// The tag owns its manager pin; later upgrades must not invalidate older tags.
export function checkPnpmReleaseInputs(root) {
  const required = [
    "package.json",
    "pnpm-lock.yaml",
    ".npmrc",
    "pnpm-workspace.yaml",
    "scripts/bootstrap-pnpm.mjs",
  ];
  try {
    for (const name of required) {
      const path = resolve(root, name);
      if (!lstatSync(path).isFile() || readFileSync(path, "utf8").trim() === "") {
        throw new Error(`${name} must be a nonempty regular file`);
      }
    }
    const { packageManager } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    if (typeof packageManager !== "string" || !/^pnpm@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\+sha512\.[a-f0-9]{128}$/u.test(packageManager)) {
      throw new Error("packageManager must pin an exact pnpm version with SHA-512 integrity");
    }
    const settings = new Map(
      readFileSync(resolve(root, ".npmrc"), "utf8")
        .split(/\r?\n/u)
        .filter((line) => line.trim() && !/^\s*[#;]/u.test(line))
        .map((line) => line.split("=").map((part) => part.trim())),
    );
    for (const [key, value] of Object.entries({
      "save-exact": "true",
      "node-linker": "isolated",
      "enable-pre-post-scripts": "true",
      "manage-package-manager-versions": "false",
      "package-manager-strict": "true",
      "package-manager-strict-version": "true",
    })) {
      if (settings.get(key) !== value) throw new Error(`.npmrc must set ${key}=${value}`);
    }
  } catch (error) {
    throw new Error(
      `Unpublished release builds require tagged pnpm inputs: ${error.message}. ` +
      "Create a new release from a pnpm-enabled commit; npm-only historical tags cannot be rebuilt. " +
      "Already-published npm versions can use verification-only recovery.",
      { cause: error },
    );
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    checkPnpmReleaseInputs(resolve(process.argv[2] ?? "."));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
