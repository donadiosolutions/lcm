import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
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
