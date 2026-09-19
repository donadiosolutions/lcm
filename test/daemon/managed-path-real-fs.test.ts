import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const platformMocks = vi.hoisted(() => {
  const getBuiltinModule = (process as NodeJS.Process & {
    getBuiltinModule: (specifier: string) => unknown;
  }).getBuiltinModule;
  const os = getBuiltinModule("node:os") as typeof import("node:os");
  return {
    homedir: vi.fn(os.homedir),
    userInfo: vi.fn(os.userInfo),
  };
});

vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: platformMocks.homedir,
  userInfo: platformMocks.userInfo,
}));

import {
  managedDaemonPathForStableLaunch,
  SYSTEMD_DAEMON_PATH,
} from "../../src/daemon/managed-path.js";

const fixtureRoots: string[] = [];

afterEach(() => {
  platformMocks.homedir.mockReset();
  platformMocks.userInfo.mockReset();
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true });
  }
});

describe("stable managed daemon PATH canonicalization", () => {
  it.each(["explicit", "implicit"] as const)(
    "emits the canonical home bin for a checkout symlink with %s home authentication",
    (homeAuthentication) => {
      const root = mkdtempSync(join(tmpdir(), "lcm-managed-path-real-fs-"));
      fixtureRoots.push(root);
      const home = join(root, "home");
      const checkout = join(root, "checkout");
      mkdirSync(join(home, ".local", "bin"), { recursive: true });
      mkdirSync(checkout);
      symlinkSync(join(home, ".local"), join(checkout, ".local"), "dir");

      platformMocks.homedir.mockReturnValue(home);
      platformMocks.userInfo.mockReturnValue({
        username: "alice",
        uid: typeof process.getuid === "function" ? process.getuid() : 1000,
        gid: 1000,
        shell: "/bin/sh",
        homedir: home,
      });

      const managedPath = managedDaemonPathForStableLaunch(
        "/usr/bin/node",
        [
          join(
            checkout,
            ".local/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
          ),
          "daemon",
          "start",
        ],
        join(root, "state"),
        homeAuthentication === "explicit" ? home : undefined,
      );

      expect(managedPath).toBe(`${join(home, ".local/bin")}:${SYSTEMD_DAEMON_PATH}`);
      expect(managedPath.split(":"))
        .not.toContain(join(checkout, ".local/bin"));
    },
  );

  it("rejects a canonical stable bin whose realpath introduces the PATH delimiter", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-managed-path-real-fs-"));
    fixtureRoots.push(root);
    const canonicalHome = join(root, "home:canonical");
    const homeAlias = join(root, "home-alias");
    mkdirSync(join(canonicalHome, ".local", "bin"), { recursive: true });
    mkdirSync(
      join(canonicalHome, ".local", "lib", "node_modules", "@donadiosolutions", "lcm", "dist"),
      { recursive: true },
    );
    symlinkSync(canonicalHome, homeAlias, "dir");

    const managedPath = managedDaemonPathForStableLaunch(
      "/usr/bin/node",
      [
        join(
          homeAlias,
          ".local/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
        ),
        "daemon",
        "start",
      ],
      join(root, "state"),
      homeAlias,
    );

    expect(managedPath).toBe(SYSTEMD_DAEMON_PATH);
  });
});
