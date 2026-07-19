import { spawnSync } from "node:child_process";
import { parseReleaseTag } from "./release-tag-policy.mjs";

export const PACKAGE_NAME = "@donadiosolutions/lcm";

function compareReleaseVersions(left, right) {
  const a = parseReleaseTag(left.startsWith("v") ? left : `v${left}`);
  const b = parseReleaseTag(right.startsWith("v") ? right : `v${right}`);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.beta === undefined && b.beta === undefined) return 0;
  if (a.beta === undefined) return 1;
  if (b.beta === undefined) return -1;
  return Math.sign(a.beta - b.beta);
}

function defaultRunNpm(args) {
  return spawnSync("npm", args, { encoding: "utf8" });
}

function npmView(args, label, runNpm, { allowEmpty = false } = {}) {
  let result;
  try {
    result = runNpm(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to query npm for ${label}: ${message}`, { cause: error });
  }
  if (result.error) {
    throw new Error(`Unable to query npm for ${label}: ${result.error.message}`, {
      cause: result.error,
    });
  }

  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  const output = [stdout, stderr].filter(Boolean).join("\n");
  if (result.status === 0) {
    if (stdout.length > 0) return { found: true, output: stdout };
    if (allowEmpty) return { found: false, output: "" };
    throw new Error(`npm returned an empty response for ${label}`);
  }
  if (/E404|404 Not Found/iu.test(output)) return { found: false, output: "" };
  throw new Error(`Unable to query npm for ${label}${output ? `:\n${output}` : ""}`);
}

function parseJsonResult(result, label, fallback) {
  if (!result.found) return fallback;
  try {
    return JSON.parse(result.output);
  } catch (error) {
    throw new Error(`npm returned invalid JSON for ${label}`, { cause: error });
  }
}

export function assertReleaseCanAdvanceDistTag({ version, distTags = {}, alreadyPublished = false }) {
  const target = parseReleaseTag(`v${version}`);
  const tagName = target.isBeta ? "beta" : "latest";
  const current = distTags[tagName];
  if (current === undefined) return;

  const comparison = compareReleaseVersions(target.version, current);
  if (comparison < 0 || (comparison === 0 && !alreadyPublished)) {
    throw new Error(`Refusing to move npm ${tagName} from ${current} to ${version}`);
  }
}

function highestStableVersion(versions) {
  const values = Array.isArray(versions) ? versions : [versions];
  const stable = values.flatMap((version) => {
    try {
      const parsed = parseReleaseTag(`v${version}`);
      return parsed.isBeta ? [] : [parsed.version];
    } catch {
      return [];
    }
  });
  stable.sort((left, right) => compareReleaseVersions(right, left));
  return stable[0];
}

export function assertNpmDistTags({ version, versions, distTags }) {
  const target = parseReleaseTag(`v${version}`);
  const publishedVersions = Array.isArray(versions) ? versions : [versions];
  if (!publishedVersions.includes(version)) {
    throw new Error(`${PACKAGE_NAME}@${version} is not present in the npm version list`);
  }

  const highestStable = highestStableVersion(publishedVersions);
  if (!highestStable) throw new Error("npm has no stable release for the latest dist-tag");
  if (distTags.latest !== highestStable) {
    throw new Error(
      `npm latest must point to highest stable ${highestStable}, found ${distTags.latest ?? "unset"}`,
    );
  }
  if (target.isBeta) {
    if (distTags.beta !== version) {
      throw new Error(`npm beta must point to ${version}, found ${distTags.beta ?? "unset"}`);
    }
  } else if (distTags.latest !== version) {
    throw new Error(`npm latest must point to stable release ${version}`);
  }
}

export function checkNpmReleaseState({
  version,
  packageName = PACKAGE_NAME,
  runNpm = defaultRunNpm,
}) {
  parseReleaseTag(`v${version}`);
  const published = npmView(
    ["view", `${packageName}@${version}`, "version"],
    `${packageName}@${version}`,
    runNpm,
  );
  if (published.found && published.output !== version) {
    throw new Error(
      `npm returned unexpected version ${JSON.stringify(published.output)} for ${packageName}@${version}`,
    );
  }

  const distTagResult = npmView(
    ["view", packageName, "dist-tags", "--json"],
    `${packageName} dist-tags`,
    runNpm,
    { allowEmpty: true },
  );
  const distTags = parseJsonResult(distTagResult, `${packageName} dist-tags`, {});
  if (distTags === null || typeof distTags !== "object" || Array.isArray(distTags)) {
    throw new Error(`npm returned invalid JSON for ${packageName} dist-tags`);
  }

  const alreadyPublished = published.found;
  assertReleaseCanAdvanceDistTag({ version, distTags, alreadyPublished });
  return { alreadyPublished, distTags };
}

export function verifyNpmRelease({ version, packageName = PACKAGE_NAME, runNpm = defaultRunNpm }) {
  parseReleaseTag(`v${version}`);
  const published = npmView(
    ["view", `${packageName}@${version}`, "version"],
    `${packageName}@${version}`,
    runNpm,
  );
  if (!published.found || published.output !== version) {
    throw new Error(`${packageName}@${version} was not published with the expected version`);
  }
  const versionsResult = npmView(
    ["view", packageName, "versions", "--json"],
    `${packageName} versions`,
    runNpm,
  );
  const distTagResult = npmView(
    ["view", packageName, "dist-tags", "--json"],
    `${packageName} dist-tags`,
    runNpm,
    { allowEmpty: true },
  );
  const versions = parseJsonResult(versionsResult, `${packageName} versions`, []);
  const distTags = parseJsonResult(distTagResult, `${packageName} dist-tags`, {});
  if (distTags === null || typeof distTags !== "object" || Array.isArray(distTags)) {
    throw new Error(`npm returned invalid JSON for ${packageName} dist-tags`);
  }
  assertNpmDistTags({ version, versions, distTags });
  return { versions, distTags };
}
