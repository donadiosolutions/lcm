import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join, parse, win32 } from "node:path";

const POSIX_FALLBACK_PARENTS = ["/var/tmp", "/tmp"];

function deduplicate(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
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
      (environment.SystemRoot ?? environment.WINDIR)
        ? win32.join(environment.SystemRoot ?? environment.WINDIR, "Temp")
        : undefined,
    ].filter((value) => typeof value === "string" && value.length > 0)
    : [temporaryRoot(), ...POSIX_FALLBACK_PARENTS];
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
  const explicitVariable = options.explicitVariable
    ?? (environment.LCM_TEST_VITEST_RUNTIME_ROOT_PARENT !== undefined
      ? "LCM_TEST_VITEST_RUNTIME_ROOT_PARENT"
      : environment.LCM_TEST_HARNESS_TMPDIR !== undefined
        ? "LCM_TEST_HARNESS_TMPDIR"
        : undefined);
  const candidates = options.candidateParents
      ?? candidateTemporaryParents(
        environment,
        options.platformName ?? platform(),
        explicitVariable,
        options.temporaryRoot ?? tmpdir,
      );
  const diagnostics = [];
  const seen = new Set();
  for (const candidate of candidates) {
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
  const explicitVariable = options.explicitVariable
    ?? (environment.LCM_TEST_VITEST_RUNTIME_ROOT_PARENT !== undefined
      ? "LCM_TEST_VITEST_RUNTIME_ROOT_PARENT"
      : environment.LCM_TEST_HARNESS_TMPDIR !== undefined
        ? "LCM_TEST_HARNESS_TMPDIR"
        : undefined);
  const candidates = options.candidateParents
    ?? candidateTemporaryParents(
      environment,
      options.platformName ?? platform(),
      explicitVariable,
      options.temporaryRoot ?? tmpdir,
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
