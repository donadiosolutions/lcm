import { describe, expect, it } from "vitest";
import { join, relative, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { eventsDbPath, eventsDir } from "../src/db/events-path.js";
import { projectDir, projectDbPath, projectMetaPath } from "../src/daemon/project.js";
import { configPath, daemonPidPath, daemonTokenPath } from "../src/runtime-paths.js";

function isUnder(candidate: string, base: string): boolean {
  const rel = relative(resolve(base), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

describe("test runtime home isolation", () => {
  it("routes LCM runtime paths under the Vitest sandbox home", () => {
    const testHome = process.env.HOME;
    const realHome = process.env.LCM_TEST_REAL_HOME;
    expect(testHome).toBeTruthy();
    expect(process.env.LCM_TEST_HOME).toBe(testHome);
    expect(process.env.USERPROFILE).toBe(testHome);
    expect(process.env.LCM_TEST_REAL_USERPROFILE).toBeDefined();
    expect(realHome).toBeDefined();
    expect(testHome).not.toBe(realHome);

    const cwd = "/some/project";
    const paths = [
      eventsDir(),
      eventsDbPath(cwd),
      projectDir(cwd),
      projectDbPath(cwd),
      projectMetaPath(cwd),
      configPath(),
      daemonPidPath(),
      daemonTokenPath(),
    ];

    for (const path of paths) {
      expect(path).toContain(".lcm");
      expect(isUnder(path, testHome!)).toBe(true);
      if (realHome) {
        expect(isUnder(path, realHome)).toBe(false);
      }
    }
  });

  it("recomputes eventsDir when HOME changes after module import", () => {
    const originalHome = process.env.HOME;
    const nextHome = mkdtempSync(join(tmpdir(), "lcm-runtime-home-change-"));
    process.env.HOME = nextHome;
    try {
      expect(eventsDir()).toBe(join(nextHome, ".lcm", "events"));
    } finally {
      process.env.HOME = originalHome;
      rmSync(nextHome, { recursive: true, force: true });
    }
  });
});
