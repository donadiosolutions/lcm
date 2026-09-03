import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrapLcmHome, migrateLegacyHomeIfNeeded } from "../src/runtime-paths.js";

const enabled = process.platform === "linux" && process.env.LCM_RUNTIME_PATHS_SYSTEMD_INTEGRATION === "1";

describe("runtime paths user-systemd namespace integration", () => {
  it("proves the constrained user-systemd path and performs real admission", () => {
    if (!enabled) return;
    const parent = "/tmp";
    if (statSync(parent).uid !== 0) {
      throw new Error("user-systemd integration requires a root-owned host /tmp parent");
    }
    const home = mkdtempSync(join(parent, "lcm-runtime-systemd-home-"));
    try {
      bootstrapLcmHome(home);
      const runtimePath = join(process.cwd(), "dist", "src", "runtime-paths.js");
      const probe = spawnSync("systemd-run", [
        "--user", "--wait", "--collect", "--pipe", "--property=PrivateTmp=yes",
        `--property=BindPaths=${parent}:${parent}`,
        `--property=WorkingDirectory=${process.cwd()}`,
        `--setenv=HOME=${home}`,
        process.execPath, "--input-type=module", "-e",
        `import { statSync, readFileSync } from 'node:fs'; import { dirname } from 'node:path'; const parent=statSync(dirname(process.env.HOME)); const home=statSync(process.env.HOME); const map=readFileSync('/proc/self/uid_map','utf8'); if ((parent.mode&4095)!==1777 || parent.uid!==65534 || home.uid!==process.getuid() || map.includes(' 0 ')) process.exit(11); const runtime=await import(${JSON.stringify(`file://${runtimePath}`)}); runtime.migrateLegacyHomeIfNeeded(process.env.HOME);`,
      ], { encoding: "utf8", timeout: 30_000, env: { ...process.env, HOME: home } });
      if (probe.status !== 0) throw new Error(`user-systemd integration unavailable: ${probe.stderr}`);
      expect(migrateLegacyHomeIfNeeded(home)).toMatchObject({ migrated: false });
      expect(existsSync(join(home, ".lcm"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
