import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrapLcmHome } from "../src/runtime-paths.js";

const enabled = process.platform === "linux"
  && process.env.LCM_RUNTIME_PATHS_SYSTEMD_INTEGRATION === "1";
const sentinel = "LCM_RUNTIME_PATHS_SYSTEMD_SENTINEL=admitted";

describe.runIf(enabled)("runtime paths user-systemd namespace integration", () => {
  it("proves the constrained user-systemd path and performs real admission", () => {
    const runRoot = process.env.LCM_RUNTIME_PATHS_SYSTEMD_RUN_ROOT;
    if (runRoot === undefined || runRoot.length === 0) {
      throw new Error("runtime paths integration requires LCM_RUNTIME_PATHS_SYSTEMD_RUN_ROOT");
    }
    const canonicalRoot = realpathSync(runRoot);
    if (canonicalRoot !== runRoot) {
      throw new Error("runtime paths integration setup failed: run root path is not canonical");
    }
    const rootStat = statSync(canonicalRoot);
    expect(rootStat.uid, "run root must be owned by host root").toBe(0);
    expect(rootStat.gid, "run root must be owned by host root group").toBe(0);
    expect(rootStat.mode & 0o7777, "run root must have exact mode 1777").toBe(0o1777);

    const home = mkdtempSync(join(canonicalRoot, "home-"));
    try {
      expect(dirname(realpathSync(home))).toBe(canonicalRoot);
      expect(statSync(home).mode & 0o7777).toBe(0o700);
      expect(statSync(home).uid).toBe(process.getuid?.());
      bootstrapLcmHome(home);
      expect(existsSync(join(home, ".lcm", "home-parent-witness.json"))).toBe(true);

      const runtimePath = join(process.cwd(), "dist", "src", "runtime-paths.js");
      const authPath = join(process.cwd(), "dist", "src", "home-parent-auth.js");
      const child = [
        "import { realpathSync, readFileSync, statSync } from 'node:fs';",
        "import { dirname } from 'node:path';",
        `import { parseUidMap, namespaceUidForParentUid } from ${JSON.stringify(`file://${authPath}`)};`,
        `const expectedSentinel = ${JSON.stringify(sentinel)};`,
        "const home = process.env.HOME;",
        "if (typeof home !== 'string') throw new Error('child HOME is missing');",
        "const parentPath = dirname(home);",
        "if (realpathSync(parentPath) !== parentPath) throw new Error('child parent path is not canonical');",
        "const parent = statSync(parentPath);",
        "const homeStat = statSync(home);",
        "const overflow = Number(readFileSync('/proc/sys/kernel/overflowuid', 'utf8').trim());",
        "const overflowGid = Number(readFileSync('/proc/sys/kernel/overflowgid', 'utf8').trim());",
        "if (!Number.isSafeInteger(overflow) || !Number.isSafeInteger(overflowGid) || parent.uid !== overflow || parent.gid !== overflowGid || (parent.mode & 0o7777) !== 0o1777) throw new Error('child parent overflow topology is invalid');",
        "if (homeStat.uid !== process.getuid() || (homeStat.mode & 0o7777) !== 0o700) throw new Error('child HOME topology is invalid');",
        "const ranges = parseUidMap(readFileSync('/proc/self/uid_map', 'utf8'));",
        "if (namespaceUidForParentUid(ranges, 0) !== undefined) throw new Error('child root is mapped');",
        `const runtime = await import(${JSON.stringify(`file://${runtimePath}`)});`,
        "runtime.migrateLegacyHomeIfNeeded(home);",
        "process.stdout.write(expectedSentinel + '\\n');",
      ].join(" ");
      const result = spawnSync("systemd-run", [
        "--user", "--wait", "--collect", "--pipe", "--quiet", "--property=PrivateTmp=yes",
        `--property=BindPaths=${canonicalRoot}:${canonicalRoot}`,
        `--property=WorkingDirectory=${process.cwd()}`,
        `--setenv=HOME=${home}`,
        process.execPath, "--input-type=module", "-e", child,
      ], { encoding: "utf8", timeout: 30_000, env: { ...process.env, HOME: home } });

      if (result.error !== undefined) {
        throw new Error(`user-systemd child could not be started: ${result.error.message}`);
      }
      expect(result.status, `user-systemd child exited with signal ${result.signal ?? "unknown"}`).toBe(0);
      expect(result.signal, "user-systemd child must not be signalled").toBeNull();
      expect(result.stderr, "user-systemd child stderr must be empty").toBe("");
      expect(result.stdout.trim(), "user-systemd child must emit one admission sentinel").toBe(sentinel);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
