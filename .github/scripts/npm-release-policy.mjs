import { spawnSync } from "node:child_process";
import { parseReleaseTag } from "./release-tag-policy.mjs";

export const PACKAGE_NAME = "@donadiosolutions/lcm";
export const NPM_QUERY_TIMEOUT_MS = 60_000;
export const NPM_VERIFY_DELAYS_MS = Object.freeze([2_000, 4_000, 8_000, 16_000]);

const FAILURE_SCAN_LIMIT = 8_192;
const FAILURE_LABEL_LIMIT = 160;
const ALLOWLISTED_ERROR_CODES = Object.freeze([
  "E400",
  "E401",
  "E403",
  "E404",
  "E409",
  "E429",
  "E500",
  "E502",
  "E503",
  "E504",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ERR_SOCKET_TIMEOUT",
  "ETIMEDOUT",
]);

function safeFailureLabel(value) {
  const bounded = typeof value === "string" ? value.slice(0, FAILURE_LABEL_LIMIT) : "npm request";
  return bounded.replace(/[^\w@./ -]+/gu, "?");
}

function classifyErrorCode(...values) {
  for (const value of values) {
    let direct;
    try {
      direct =
        value !== null && typeof value === "object" && typeof value.code === "string"
          ? value.code.slice(0, 64).toUpperCase()
          : undefined;
    } catch {
      direct = undefined;
    }
    if (direct && ALLOWLISTED_ERROR_CODES.includes(direct)) return direct;

    let text = "";
    try {
      if (typeof value === "string") text = value.slice(0, FAILURE_SCAN_LIMIT);
      else if (value instanceof Error) text = value.message.slice(0, FAILURE_SCAN_LIMIT);
    } catch {
      text = "";
    }
    const upper = text.toUpperCase();
    if (upper.includes("404 NOT FOUND")) return "E404";
    for (const code of ALLOWLISTED_ERROR_CODES) {
      const start = upper.indexOf(code);
      if (start === -1) continue;
      const before = upper[start - 1];
      const after = upper[start + code.length];
      if ((!before || !/[A-Z0-9_]/u.test(before)) && (!after || !/[A-Z0-9_]/u.test(after))) {
        return code;
      }
    }
  }
  return undefined;
}

function npmQueryFailure(label, { code, status, signal } = {}) {
  const safeLabel = safeFailureLabel(label);
  if (code === "ETIMEDOUT" || code === "ERR_SOCKET_TIMEOUT") {
    return new Error(`npm query for ${safeLabel} timed out after ${NPM_QUERY_TIMEOUT_MS}ms (${code})`);
  }
  if (code) return new Error(`npm query for ${safeLabel} failed with ${code}`);
  if (typeof signal === "string" && /^SIG[A-Z0-9]{1,16}$/u.test(signal)) {
    return new Error(`npm query for ${safeLabel} terminated by signal ${signal}`);
  }
  if (Number.isSafeInteger(status)) {
    return new Error(`npm query for ${safeLabel} failed with status ${status}`);
  }
  return new Error(`npm query for ${safeLabel} failed`);
}

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
  return spawnSync("npm", args, {
    encoding: "utf8",
    timeout: NPM_QUERY_TIMEOUT_MS,
    killSignal: "SIGTERM",
  });
}

function npmView(args, label, runNpm) {
  let result;
  try {
    result = runNpm(args);
  } catch (error) {
    throw npmQueryFailure(label, { code: classifyErrorCode(error) });
  }
  if (result === null || typeof result !== "object") throw npmQueryFailure(label);
  if (result.error) {
    throw npmQueryFailure(label, { code: classifyErrorCode(result.error) });
  }
  if (result.signal) {
    throw npmQueryFailure(label, { signal: result.signal });
  }

  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (result.status === 0) {
    const output = stdout.trim();
    if (output.length > 0) return { found: true, output };
    throw new Error(`npm returned an empty response for ${safeFailureLabel(label)}`);
  }
  const code = classifyErrorCode(stdout, stderr);
  if (code === "E404") return { found: false, output: "" };
  throw npmQueryFailure(label, { code, status: result.status });
}

function parseJsonResult(result, label, fallback) {
  if (!result.found) return fallback;
  try {
    return JSON.parse(result.output);
  } catch {
    throw new Error(`npm returned invalid JSON for ${safeFailureLabel(label)}`);
  }
}

export function assertReleaseCanAdvanceDistTag({ version, distTags = {}, alreadyPublished = false }) {
  const target = parseReleaseTag(`v${version}`);
  const boundaries = target.isBeta
    ? [
        ["beta", true],
        ["latest", false],
      ]
    : [["latest", false]];

  for (const [tagName, expectedBeta] of boundaries) {
    const current = distTags[tagName];
    if (current === undefined) continue;
    if (typeof current !== "string") {
      throw new Error(`npm ${tagName} dist-tag must contain a canonical version string`);
    }

    let parsedCurrent;
    try {
      parsedCurrent = parseReleaseTag(`v${current}`);
    } catch {
      throw new Error(`npm ${tagName} points to an unsupported version`);
    }
    if (parsedCurrent.isBeta !== expectedBeta) {
      throw new Error(
        `npm ${tagName} must point to a canonical ${expectedBeta ? "beta" : "stable"} version`,
      );
    }

    const comparison = compareReleaseVersions(target.version, parsedCurrent.version);
    const samePublishedVersion = comparison === 0 && alreadyPublished;
    if (comparison < 0 || (comparison === 0 && !samePublishedVersion)) {
      throw new Error(`Refusing to move npm ${tagName} backward or reuse an unpublished version`);
    }
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

class IncompleteNpmReleaseError extends Error {}

function canonicalPublishedVersions(versions, packageName) {
  const values = typeof versions === "string" ? [versions] : versions;
  if (!Array.isArray(values)) {
    throw new Error(`npm returned invalid JSON for ${safeFailureLabel(`${packageName} versions`)}`);
  }
  return values.map((version) => {
    if (typeof version !== "string") {
      throw new Error(`npm returned invalid JSON for ${safeFailureLabel(`${packageName} versions`)}`);
    }
    let parsed;
    try {
      parsed = parseReleaseTag(`v${version}`);
    } catch {
      throw new Error(`npm returned an unsupported version for ${safeFailureLabel(packageName)}`);
    }
    if (parsed.version !== version) {
      throw new Error(`npm returned a non-canonical version for ${safeFailureLabel(packageName)}`);
    }
    return parsed.version;
  });
}

function canonicalDistTag(distTags, tagName) {
  const current = distTags[tagName];
  if (current === undefined) return undefined;
  if (typeof current !== "string") {
    throw new Error(`npm ${tagName} dist-tag must contain a canonical version string`);
  }
  let parsed;
  try {
    parsed = parseReleaseTag(`v${current}`);
  } catch {
    throw new Error(`npm ${tagName} points to an unsupported version`);
  }
  if (parsed.version !== current) {
    throw new Error(`npm ${tagName} must contain a canonical version string`);
  }
  return parsed;
}

function assertCompleteNpmSnapshot({ version, packageName, published, versions, distTags }) {
  const target = parseReleaseTag(`v${version}`);
  const publishedVersions = canonicalPublishedVersions(versions, packageName);
  const latest = canonicalDistTag(distTags, "latest");
  const beta = canonicalDistTag(distTags, "beta");
  const incomplete = [];

  if (!published.found) incomplete.push("exact version is not visible");
  else if (published.output !== version) {
    throw new Error(`npm returned an unexpected exact-version response for ${packageName}@${version}`);
  }
  if (!publishedVersions.includes(version)) incomplete.push("version list is not updated");

  const highestStable = highestStableVersion(publishedVersions);
  if (!highestStable) {
    incomplete.push("stable version list is not visible");
  } else if (!latest) {
    incomplete.push("latest dist-tag is not visible");
  } else {
    if (latest.isBeta) throw new Error("npm latest must point to a canonical stable version");
    const latestComparison = compareReleaseVersions(latest.version, highestStable);
    if (latestComparison < 0) incomplete.push("latest dist-tag is older than the version list");
    else if (latestComparison > 0) incomplete.push("version list is missing the latest release");
  }

  if (target.isBeta) {
    if (!beta) incomplete.push("beta dist-tag is not visible");
    else {
      if (!beta.isBeta) throw new Error("npm beta must point to a canonical beta version");
      const betaComparison = compareReleaseVersions(beta.version, version);
      if (betaComparison < 0) incomplete.push("beta dist-tag is older than the release");
      else if (betaComparison > 0) {
        throw new Error("npm beta points to a newer release than the published version");
      }
    }
  } else if (latest) {
    const latestComparison = compareReleaseVersions(latest.version, version);
    if (latestComparison < 0) incomplete.push("latest dist-tag is older than the release");
    else if (latestComparison > 0) {
      throw new Error("npm latest points to a newer release than the published version");
    }
  }

  if (incomplete.length > 0) {
    throw new IncompleteNpmReleaseError(
      `npm metadata propagation is incomplete: ${[...new Set(incomplete)].join("; ")}`,
    );
  }
  assertNpmDistTags({ version, versions: publishedVersions, distTags });
  return { versions: publishedVersions, distTags };
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
    throw new Error("npm latest must point to the highest published stable version");
  }
  if (target.isBeta) {
    if (distTags.beta !== version) {
      throw new Error("npm beta must point to the published beta release version");
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
    throw new Error(`npm returned an unexpected exact-version response for ${packageName}@${version}`);
  }

  const distTagResult = npmView(
    ["view", packageName, "dist-tags", "--json"],
    `${packageName} dist-tags`,
    runNpm,
  );
  const distTags = parseJsonResult(distTagResult, `${packageName} dist-tags`, {});
  if (distTags === null || typeof distTags !== "object" || Array.isArray(distTags)) {
    throw new Error(`npm returned invalid JSON for ${packageName} dist-tags`);
  }

  const alreadyPublished = published.found;
  assertReleaseCanAdvanceDistTag({ version, distTags, alreadyPublished });
  return { alreadyPublished, distTags };
}

function readNpmReleaseSnapshot({ version, packageName, runNpm }) {
  parseReleaseTag(`v${version}`);
  const published = npmView(
    ["view", `${packageName}@${version}`, "version"],
    `${packageName}@${version}`,
    runNpm,
  );
  const versionsResult = npmView(
    ["view", packageName, "versions", "--json"],
    `${packageName} versions`,
    runNpm,
  );
  const distTagResult = npmView(
    ["view", packageName, "dist-tags", "--json"],
    `${packageName} dist-tags`,
    runNpm,
  );
  const versions = parseJsonResult(versionsResult, `${packageName} versions`, []);
  const distTags = parseJsonResult(distTagResult, `${packageName} dist-tags`, {});
  if (distTags === null || typeof distTags !== "object" || Array.isArray(distTags)) {
    throw new Error(`npm returned invalid JSON for ${packageName} dist-tags`);
  }
  return { published, versions, distTags };
}

export async function verifyNpmRelease({
  version,
  packageName = PACKAGE_NAME,
  runNpm = defaultRunNpm,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
}) {
  for (let attempt = 0; attempt <= NPM_VERIFY_DELAYS_MS.length; attempt += 1) {
    const snapshot = readNpmReleaseSnapshot({ version, packageName, runNpm });
    try {
      return assertCompleteNpmSnapshot({ version, packageName, ...snapshot });
    } catch (error) {
      if (
        !(error instanceof IncompleteNpmReleaseError) ||
        attempt === NPM_VERIFY_DELAYS_MS.length
      ) {
        throw error;
      }
      await sleep(NPM_VERIFY_DELAYS_MS[attempt]);
    }
  }
  throw new Error("npm release verification exhausted unexpectedly");
}
