/** Explicit developer update command; normal Vitest execution is check-only. */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const vitest = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const result = spawnSync(process.execPath, [vitest, "run", "test/daemon/routes/surface-parity-inventory.test.ts"], {
  cwd: root,
  env: { ...process.env, LCM_SURFACE_MATRIX_UPDATE: "1" },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
