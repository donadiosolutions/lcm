import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { packageRootFor } from "../runtime-root.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the package version by trying multiple candidate paths so that
 * PKG_VERSION works correctly in both production (dist/src/daemon/) and
 * dev/test (src/daemon/) environments.
 *
 * Returns `undefined` when the version cannot be determined. Security-sensitive
 * lifecycle callers treat that as unverifiable and fail closed before sending
 * daemon credentials.
 */
export const PKG_VERSION: string | undefined = (() => {
  const candidates = [
    join(packageRootFor(import.meta.url, 3), "package.json"),
    // Dev / vitest: src/daemon → 2 levels up = package root
    join(__dirname, "..", "..", "package.json"),
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, "utf-8")) as { version?: unknown };
      if (typeof pkg.version === "string" && pkg.version) return pkg.version;
    } catch { /* try next candidate */ }
  }
  return undefined;
})();

/**
 * Resolve the packaged single-file runtime identified by a module URL.
 *
 * Source and separately compiled modules intentionally return `undefined`;
 * only the executing `lcm.mjs` bundle is a stable packaged entrypoint.
 */
export function packagedRuntimeEntrypoint(moduleUrl: string): string | undefined {
  try {
    const runtimePath = fileURLToPath(moduleUrl);
    return basename(runtimePath) === "lcm.mjs" ? runtimePath : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Hash the packaged single-file runtime identified by a module URL.
 *
 * The exported entrypoint and digest below are captured once when the process
 * loads this module, so a later in-place rebuild cannot make a stale daemon
 * claim either part of the new runtime identity.
 */
export function packagedRuntimeDigest(moduleUrl: string): string | undefined {
  const runtimePath = packagedRuntimeEntrypoint(moduleUrl);
  if (runtimePath === undefined) return undefined;
  try {
    return createHash("sha256").update(readFileSync(runtimePath)).digest("hex");
  } catch {
    return undefined;
  }
}

export const PACKAGED_RUNTIME_ENTRYPOINT: string | undefined = packagedRuntimeEntrypoint(import.meta.url);
export const RUNTIME_DIGEST: string | undefined = packagedRuntimeDigest(import.meta.url);
