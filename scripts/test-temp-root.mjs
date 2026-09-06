import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, win32 } from "node:path";

const POSIX_FALLBACK_PARENTS = ["/var/tmp", "/tmp"];
export const LCM_TEST_HARNESS_ORIGINAL_TEMP_PARENTS =
  "LCM_TEST_HARNESS_ORIGINAL_TEMP_PARENTS";
export const MAX_ORIGINAL_TEMP_PARENTS = 8;
export const MAX_ORIGINAL_TEMP_PARENTS_SERIALIZED_LENGTH = 8192;

function deduplicate(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function isAbsolutePlatformPath(value, platformName) {
  return platformName === "win32" ? win32.isAbsolute(value) : isAbsolute(value);
}

function selectedExplicitVariable(environment, explicitVariable) {
  return explicitVariable
    ?? (environment.LCM_TEST_VITEST_RUNTIME_ROOT_PARENT !== undefined
      ? "LCM_TEST_VITEST_RUNTIME_ROOT_PARENT"
      : environment.LCM_TEST_HARNESS_TMPDIR !== undefined
        ? "LCM_TEST_HARNESS_TMPDIR"
        : undefined);
}

function isValidTemporaryParent(candidate, platformName) {
  return typeof candidate === "string"
    && candidate.length > 0
    && !candidate.includes("\0")
    && isAbsolutePlatformPath(candidate, platformName)
    && (platformName !== "win32" || win32.parse(candidate).root.length > 1);
}

function selectorInputs(options, environment) {
  const platformName = options.platformName ?? platform();
  const explicitVariable = selectedExplicitVariable(
    environment,
    options.explicitVariable,
  );
  if (explicitVariable !== undefined
    && !isValidTemporaryParent(environment[explicitVariable], platformName)) {
    throw new Error(
      `${explicitVariable} must name a non-empty absolute temporary parent path without NUL bytes`,
    );
  }
  const candidates = options.candidateParents
    ?? candidateTemporaryParents(
      environment,
      platformName,
      explicitVariable,
      options.temporaryRoot ?? tmpdir,
    );
  return { candidates, explicitVariable, platformName };
}

/** Return only platform fallbacks that do not inspect live temp variables. */
export function nonLivePlatformFallbackParents(
  environment = process.env,
  platformName = platform(),
) {
  if (platformName !== "win32") return [...POSIX_FALLBACK_PARENTS];
  const systemRoot = [environment.SystemRoot, environment.WINDIR]
    .find((value) => typeof value === "string" && value.length > 0);
  return systemRoot === undefined ? [] : [win32.join(systemRoot, "Temp")];
}

/** Parse the bounded original-temp handoff. Invalid input is treated as absent. */
export function parseOriginalTemporaryParents(
  value,
  platformName = platform(),
) {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > MAX_ORIGINAL_TEMP_PARENTS_SERIALIZED_LENGTH) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (parsed === null
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || parsed.version !== 1
    || !Array.isArray(parsed.parents)
    || Object.keys(parsed).some((key) => key !== "version" && key !== "parents")
    || parsed.parents.length > MAX_ORIGINAL_TEMP_PARENTS) return undefined;
  if (parsed.parents.some((parent) => typeof parent !== "string"
    || parent.length === 0
    || parent.includes("\0")
    || !isAbsolutePlatformPath(parent, platformName))) return undefined;
  return [...parsed.parents];
}

/** Serialize a finite, platform-absolute original-temp parent set. */
export function serializeOriginalTemporaryParents(
  parents,
  platformName = platform(),
) {
  if (!Array.isArray(parents) || parents.length > MAX_ORIGINAL_TEMP_PARENTS) return undefined;
  if (parents.some((parent) => typeof parent !== "string"
    || parent.length === 0
    || parent.includes("\0")
    || !isAbsolutePlatformPath(parent, platformName))) return undefined;
  const serialized = JSON.stringify({ version: 1, parents: deduplicate(parents) });
  return serialized.length <= MAX_ORIGINAL_TEMP_PARENTS_SERIALIZED_LENGTH
    ? serialized
    : undefined;
}

/** Capture the pre-handoff candidate set when the snapshot variable is absent. */
export function captureOriginalTemporaryParents(
  environment = process.env,
  platformName = platform(),
  temporaryRoot = tmpdir,
) {
  if (environment[LCM_TEST_HARNESS_ORIGINAL_TEMP_PARENTS] !== undefined) return undefined;
  const candidates = candidateTemporaryParents(environment, platformName, null, temporaryRoot);
  const usable = candidates.filter((candidate) => typeof candidate === "string"
    && candidate.length > 0
    && !candidate.includes("\0")
    && isAbsolutePlatformPath(candidate, platformName));
  const serialized = serializeOriginalTemporaryParents(usable, platformName);
  if (serialized === undefined) return undefined;
  environment[LCM_TEST_HARNESS_ORIGINAL_TEMP_PARENTS] = serialized;
  return usable;
}

/**
 * Return the finite parent candidates used by test-only scratch allocation.
 * An explicit variable is deliberately authoritative and never falls back.
 */
export function candidateTemporaryParents(
  environment = process.env,
  platformName = platform(),
  explicitVariable,
  temporaryRoot = tmpdir,
) {
  const variable = explicitVariable === null
    ? undefined
    : explicitVariable
    ?? (environment.LCM_TEST_VITEST_RUNTIME_ROOT_PARENT !== undefined
      ? "LCM_TEST_VITEST_RUNTIME_ROOT_PARENT"
      : environment.LCM_TEST_HARNESS_TMPDIR !== undefined
        ? "LCM_TEST_HARNESS_TMPDIR"
        : undefined);
  if (variable) {
    const explicit = environment[variable];
    return explicit === undefined || explicit === "" ? [] : [explicit];
  }
  const defaults = platformName === "win32"
    ? [
      temporaryRoot(),
      environment.TEMP,
      environment.TMP,
      ...nonLivePlatformFallbackParents(environment, platformName),
    ].filter((value) => typeof value === "string" && value.length > 0)
    : [temporaryRoot(), ...nonLivePlatformFallbackParents(environment, platformName)];
  return deduplicate(defaults);
}

function markerProbe(path, dependencies) {
  const probe = dependencies.markerProbe ?? ((markerPath) => lstatSync(markerPath));
  try {
    const result = probe(path);
    if (result && typeof result === "object" && result.present === false) {
      return { present: false, error: result.error };
    }
    return { present: true };
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false };
    return { present: false, error };
  }
}

/**
 * Certify that a canonical parent and all of its real ancestors contain no
 * .git marker. Any probe error other than ENOENT is conservatively unusable.
 */
export function inspectGitFreeParent(candidate, dependencies = {}) {
  const resolvePath = dependencies.realpath ?? realpathSync;
  const pathApi = dependencies.platformName === "win32" ? win32 : { dirname, parse, join };
  let current;
  let canonical;
  try {
    canonical = resolvePath(candidate);
    current = canonical;
  } catch (error) {
    return { usable: false, reason: error?.code === "ENOENT" ? "missing" : "unverifiable", error };
  }
  const root = pathApi.parse(current).root;
  for (;;) {
    const result = markerProbe(pathApi.join(current, ".git"), dependencies);
    if (result.present) return { usable: false, parent: current, reason: "marker" };
    if (result.error) return { usable: false, parent: current, reason: "unverifiable", error: result.error };
    if (current === root) break;
    const next = pathApi.dirname(current);
    if (next === current) break;
    current = next;
  }
  return { usable: true, parent: canonical };
}

/** Return canonical candidate parents without checking marker cleanliness. */
export function canonicalCandidateParents(options = {}) {
  const environment = options.environment ?? process.env;
  const candidates = options.candidateParents
    ?? candidateTemporaryParents(
      environment,
      options.platformName ?? platform(),
      options.explicitVariable,
      options.temporaryRoot ?? tmpdir,
    );
  const resolvePath = options.realpath ?? realpathSync;
  const result = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (typeof candidate !== "string"
      || candidate.length === 0
      || candidate.includes("\0")
      || !isAbsolutePlatformPath(candidate, options.platformName ?? platform())) continue;
    try {
      const resolved = resolvePath(candidate);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        result.push(resolved);
      }
    } catch {
      // An unavailable parent cannot authenticate an existing harness record.
    }
  }
  return result;
}

function selectionError(variable, diagnostics) {
  const detail = diagnostics.length > 0
    ? diagnostics.map(({ candidate, reason }) => `${candidate} (${reason})`).join(", ")
    : "no candidates were provided";
  const prefix = variable
    ? `${variable} does not name a usable Git-free temporary parent`
    : "no usable Git-free temporary parent was found";
  return new Error(`${prefix}; tried ${detail}. Selection checks marker existence only; malformed Git metadata is never parsed.`);
}

/**
 * Select the first parent whose real ancestor chain is proven marker-free.
 * This function never creates a parent and never parses Git metadata.
 */
export function selectTestTempParent(options = {}) {
  const environment = options.environment ?? process.env;
  const { candidates, explicitVariable, platformName } = selectorInputs(
    options,
    environment,
  );
  const diagnostics = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!isValidTemporaryParent(candidate, platformName)) {
      diagnostics.push({ candidate, reason: "invalid" });
      continue;
    }
    const inspected = inspectGitFreeParent(candidate, options);
    if (inspected.parent && seen.has(inspected.parent)) continue;
    if (inspected.parent) seen.add(inspected.parent);
    if (inspected.usable) return inspected.parent;
    diagnostics.push({ candidate, reason: inspected.reason ?? "unverifiable" });
  }
  throw selectionError(explicitVariable, diagnostics);
}

/**
 * Allocate an owned mode-0700 directory below a selected parent. Creation
 * failures advance through non-explicit candidates; explicit parents fail
 * clearly and never silently fall back.
 */
export function createTestTempDirectory(options = {}) {
  const environment = options.environment ?? process.env;
  const { candidates, explicitVariable, platformName } = selectorInputs(
    options,
    environment,
  );
  const createDirectory = options.createDirectory ?? mkdtempSync;
  const secureDirectory = options.secureDirectory ?? ((path) => {
    // mkdtemp creates mode 0700 on supported platforms; callers may inject a
    // chmod seam when they need to assert or repair the mode.
    return path;
  });
  const removeDirectory = options.removeDirectory ?? ((path) => rmSync(path, { recursive: true, force: true }));
  const prefix = options.prefix ?? "lcm-test-";
  const diagnostics = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!isValidTemporaryParent(candidate, platformName)) {
      diagnostics.push({ candidate, reason: "invalid" });
      continue;
    }
    const inspected = inspectGitFreeParent(candidate, options);
    if (inspected.parent && seen.has(inspected.parent)) continue;
    if (inspected.parent) seen.add(inspected.parent);
    if (!inspected.usable) {
      diagnostics.push({ candidate, reason: inspected.reason ?? "unverifiable" });
      continue;
    }
    let root;
    try {
      root = createDirectory(join(inspected.parent, prefix));
      secureDirectory(root, 0o700);
      return { root, parent: inspected.parent };
    } catch (error) {
      if (root !== undefined) {
        try { removeDirectory(root); } catch { /* preserve the allocation error */ }
      }
      diagnostics.push({ candidate, reason: "unwritable", error });
      if (explicitVariable) throw new Error(
        `${explicitVariable} names a Git-free parent but scratch creation failed`,
        { cause: error },
      );
    }
  }
  throw selectionError(explicitVariable, diagnostics);
}
