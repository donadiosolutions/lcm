import { beforeEach, describe, expect, it, vi } from "vitest";

const platformMocks = vi.hoisted(() => {
  const getBuiltinModule = (process as NodeJS.Process & {
    getBuiltinModule: (specifier: string) => unknown;
  }).getBuiltinModule;
  const os = getBuiltinModule("node:os") as typeof import("node:os");
  return {
    actualOs: os,
    homedir: vi.fn(os.homedir),
    userInfo: vi.fn(os.userInfo),
    realpathSync: vi.fn((path: string) => path),
    statSync: vi.fn(),
  };
});

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  realpathSync: platformMocks.realpathSync,
  statSync: platformMocks.statSync,
}));

vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: platformMocks.homedir,
  userInfo: platformMocks.userInfo,
}));

import {
  managedDaemonPath,
  managedDaemonPathForStableLaunch,
  SYSTEMD_DAEMON_PATH,
} from "../../src/daemon/managed-path.js";

beforeEach(() => {
  platformMocks.homedir.mockReset().mockImplementation(platformMocks.actualOs.homedir);
  platformMocks.userInfo.mockReset().mockImplementation(platformMocks.actualOs.userInfo);
  platformMocks.realpathSync.mockReset().mockImplementation((path: string) => path);
  platformMocks.statSync.mockReset();
});

describe("managed daemon executable path", () => {
  it("prepends the directory of an absolute Node-launched LCM entrypoint", () => {
    expect(managedDaemonPath(
      "/usr/bin/node",
      ["/home/alice/.nvm/versions/node/v25.9.0/bin/lcm", "daemon", "start", "--foreground"],
    )).toBe(`/home/alice/.nvm/versions/node/v25.9.0/bin:${SYSTEMD_DAEMON_PATH}`);

    expect(managedDaemonPath(
      "/usr/bin/node",
      ["/home/alice/.codex/plugins/cache/lcm/1.4.0/lcm.mjs", "daemon", "start", "--foreground"],
    )).toBe(`/home/alice/.codex/plugins/cache/lcm/1.4.0:${SYSTEMD_DAEMON_PATH}`);

    expect(managedDaemonPath(
      "/home/alice/.nvm/versions/node/v25.9.0/bin/node",
      ["/home/alice/.claude/plugins/cache/lcm/1.4.0/lcm.mjs", "daemon", "start", "--foreground"],
    )).toBe(
      `/home/alice/.claude/plugins/cache/lcm/1.4.0:/home/alice/.nvm/versions/node/v25.9.0/bin:${SYSTEMD_DAEMON_PATH}`,
    );
  });

  it("uses an absolute directly executed LCM command and deduplicates system directories", () => {
    expect(managedDaemonPath("/usr/local/bin/lcm", ["daemon", "start", "--foreground"]))
      .toBe("/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin");
  });

  it("falls back to fixed system directories for missing or relative entrypoints", () => {
    expect(managedDaemonPath("node", ["lcm", "daemon", "start"])).toBe(SYSTEMD_DAEMON_PATH);
    expect(managedDaemonPath("/usr/bin/node", [])).toBe(SYSTEMD_DAEMON_PATH);
    expect(managedDaemonPath("lcm", ["daemon", "start"])).toBe(SYSTEMD_DAEMON_PATH);
    expect(managedDaemonPath("node", ["/opt/lcm/lcm.mjs", "daemon", "start"]))
      .toBe(`/opt/lcm:${SYSTEMD_DAEMON_PATH}`);
  });

  it("excludes project-local entrypoint directories", () => {
    expect(managedDaemonPath(
      "/usr/bin/node",
      ["/work/project/node_modules/.bin/lcm", "daemon", "start"],
    )).toBe(SYSTEMD_DAEMON_PATH);
    expect(managedDaemonPath("/work/project/bin/lcm", ["daemon", "start"], "/work/project"))
      .toBe(SYSTEMD_DAEMON_PATH);
    expect(managedDaemonPath("/tmp/npx-123/node_modules/.bin/lcm", ["daemon", "start"]))
      .toBe(SYSTEMD_DAEMON_PATH);
    expect(managedDaemonPath(
      "/usr/bin/node",
      ["/work/project/lcm.mjs", "daemon", "start"],
      "/work/project/packages/app",
    )).toBe(SYSTEMD_DAEMON_PATH);
  });

  it("preserves global prefixes outside the current project", () => {
    expect(managedDaemonPath(
      "/home/alice/.volta/bin/node",
      ["/home/alice/.volta/bin/lcm", "daemon", "start"],
      "/work/project",
    )).toBe(`/home/alice/.volta/bin:${SYSTEMD_DAEMON_PATH}`);
  });

  it("preserves canonical home-global bins while rejecting project-local lookalikes", () => {
    expect(managedDaemonPath(
      "/home/alice/.volta/bin/node",
      ["/home/alice/.volta/bin/lcm", "daemon", "start"],
      "/home/alice",
      "/home/alice",
    )).toBe(`/home/alice/.volta/bin:${SYSTEMD_DAEMON_PATH}`);
    expect(managedDaemonPath(
      "/home/alice/.asdf/installs/nodejs/24.4.1/bin/node",
      ["/home/alice/.asdf/shims/lcm", "daemon", "start"],
      "/home/alice",
      "/home/alice",
    )).toBe(
      `/home/alice/.asdf/shims:/home/alice/.asdf/installs/nodejs/24.4.1/bin:${SYSTEMD_DAEMON_PATH}`,
    );
    expect(managedDaemonPath(
      "/usr/bin/node",
      ["/work/project/.codex/plugins/cache/lcm/1.4.0/lcm.mjs", "daemon", "start"],
      "/work/project",
    )).toBe(SYSTEMD_DAEMON_PATH);
    expect(managedDaemonPath(
      "/usr/bin/node",
      ["/work/project/.claude/plugins/cache/lcm/1.4.0/lcm.mjs", "daemon", "start"],
      "/work/project/packages/app",
    )).toBe(SYSTEMD_DAEMON_PATH);
  });

  it("rejects home-scoped installation lookalikes without caller-cwd containment", () => {
    const stableAnchor = "/var/lib/lcm";
    const home = "/home/alice";
    expect(managedDaemonPathForStableLaunch(
      "/usr/bin/node",
      ["/work/project/.codex/plugins/cache/lcm/1.4.0/lcm.mjs", "daemon", "start"],
      stableAnchor,
      home,
    )).toBe(SYSTEMD_DAEMON_PATH);
    expect(managedDaemonPathForStableLaunch(
      "/usr/bin/node",
      ["/work/project/.claude/plugins/cache/lcm/1.4.0/lcm.mjs", "daemon", "start"],
      stableAnchor,
      home,
    )).toBe(SYSTEMD_DAEMON_PATH);
    expect(managedDaemonPathForStableLaunch(
      "/usr/bin/node",
      ["/work/project/.npm-global/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs", "daemon", "start"],
      stableAnchor,
      home,
    )).toBe(SYSTEMD_DAEMON_PATH);
  });

  it("rejects stable synthesized bins outside recognized owner-home layouts", () => {
    const stableAnchor = "/var/lib/lcm";
    const home = "/home/alice";
    for (const entrypoint of [
      "/work/project/.local/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
      "/home/alice/work/project/.local/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
      "/work/project/renamed-prefix/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
      "/home/alice/renamed-prefix/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
    ]) {
      expect(managedDaemonPathForStableLaunch(
        "/usr/bin/node",
        [entrypoint, "daemon", "start"],
        stableAnchor,
        home,
      )).toBe(SYSTEMD_DAEMON_PATH);
    }
  });

  it("preserves stable synthesized bins rooted at the explicit owner home", () => {
    const stableAnchor = "/var/lib/lcm";
    const home = "/home/alice";
    for (const [entrypoint, expectedBin] of [
      [
        "/home/alice/.local/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
        "/home/alice/.local/bin",
      ],
      [
        "/home/alice/.npm-global/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
        "/home/alice/.npm-global/bin",
      ],
      [
        "/home/alice/.nvm/versions/node/v25.9.0/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
        "/home/alice/.nvm/versions/node/v25.9.0/bin",
      ],
    ]) {
      expect(managedDaemonPathForStableLaunch(
        "/usr/bin/node",
        [entrypoint, "daemon", "start"],
        stableAnchor,
        home,
      )).toBe(`${expectedBin}:${SYSTEMD_DAEMON_PATH}`);
    }

    expect(managedDaemonPathForStableLaunch(
      "/opt/codex-desktop/resources/node-runtime/bin/node",
      ["/opt/lcm/lcm.mjs", "daemon", "start"],
      stableAnchor,
      home,
    )).toBe(
      `/opt/lcm:/opt/codex-desktop/resources/node-runtime/bin:${SYSTEMD_DAEMON_PATH}`,
    );
  });

  it("accepts an implicit home authenticated by passwd realpath equality", () => {
    platformMocks.homedir.mockReturnValue("/home/alias");
    platformMocks.userInfo.mockReturnValue({
      username: "alice",
      uid: 1000,
      gid: 1000,
      shell: "/bin/sh",
      homedir: "/home/account",
    });
    platformMocks.realpathSync.mockImplementation((path: string) => {
      if (path === "/home/account") return path;
      return path === "/home/alias" || path.startsWith("/home/alias/")
        ? path.replace("/home/alias", "/home/account")
        : path;
    });

    expect(managedDaemonPathForStableLaunch(
      "/usr/bin/node",
      [
        "/home/alias/.local/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
        "daemon",
        "start",
      ],
      "/var/lib/lcm",
    )).toBe(`/home/account/.local/bin:${SYSTEMD_DAEMON_PATH}`);
    expect(platformMocks.statSync).not.toHaveBeenCalled();
  });

  it("accepts an implicit isolated home owned privately by the current uid", () => {
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    platformMocks.homedir.mockReturnValue("/srv/isolated-home");
    platformMocks.userInfo.mockReturnValue({
      username: "alice",
      uid,
      gid: 1000,
      shell: "/bin/sh",
      homedir: "/home/account",
    });
    platformMocks.statSync.mockReturnValue({
      uid,
      mode: 0o40700,
      isDirectory: () => true,
    } as ReturnType<typeof import("node:fs")["statSync"]>);

    expect(managedDaemonPathForStableLaunch(
      "/usr/bin/node",
      [
        "/srv/isolated-home/.local/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
        "daemon",
        "start",
      ],
      "/var/lib/lcm",
    )).toBe(`/srv/isolated-home/.local/bin:${SYSTEMD_DAEMON_PATH}`);
  });

  it.each([
    ["foreign-owned", true, 0o40700, true],
    ["group-writable", false, 0o40720, true],
    ["other-writable", false, 0o40702, true],
    ["non-directory", false, 0o40700, false],
  ])("withdraws implicit home trust for a %s home", (_name, foreignOwned, mode, isDirectory) => {
    const currentUid = typeof process.getuid === "function" ? process.getuid() : 1000;
    platformMocks.homedir.mockReturnValue("/srv/isolated-home");
    platformMocks.userInfo.mockReturnValue({
      username: "alice",
      uid: currentUid,
      gid: 1000,
      shell: "/bin/sh",
      homedir: "/home/account",
    });
    platformMocks.statSync.mockReturnValue({
      uid: foreignOwned ? currentUid + 1 : currentUid,
      mode,
      isDirectory: () => isDirectory,
    } as ReturnType<typeof import("node:fs")["statSync"]>);

    expect(managedDaemonPathForStableLaunch(
      "/opt/codex-desktop/resources/node-runtime/bin/node",
      [
        "/srv/isolated-home/.local/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
        "daemon",
        "start",
      ],
      "/var/lib/lcm",
    )).toBe(
      `/opt/codex-desktop/resources/node-runtime/bin:${SYSTEMD_DAEMON_PATH}`,
    );
  });

  it("withdraws implicit home trust when the process uid is unavailable", () => {
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    platformMocks.homedir.mockReturnValue("/srv/isolated-home");
    platformMocks.userInfo.mockReturnValue({
      username: "alice",
      uid,
      gid: 1000,
      shell: "/bin/sh",
      homedir: "/home/account",
    });
    platformMocks.statSync.mockReturnValue({
      uid,
      mode: 0o40700,
      isDirectory: () => true,
    } as ReturnType<typeof import("node:fs")["statSync"]>);
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    try {
      expect(managedDaemonPathForStableLaunch(
        "/usr/bin/node",
        [
          "/srv/isolated-home/.local/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
          "daemon",
          "start",
        ],
        "/var/lib/lcm",
      )).toBe(SYSTEMD_DAEMON_PATH);
    } finally {
      if (descriptor) Object.defineProperty(process, "getuid", descriptor);
    }
  });

  it("withdraws implicit home trust when home canonicalization fails", () => {
    platformMocks.homedir.mockReturnValue("/srv/isolated-home");
    platformMocks.realpathSync.mockImplementationOnce(() => { throw new Error("realpath failed"); });
    expect(managedDaemonPathForStableLaunch(
      "/usr/bin/node",
      [
        "/srv/isolated-home/.local/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
        "daemon",
        "start",
      ],
      "/var/lib/lcm",
    )).toBe(SYSTEMD_DAEMON_PATH);
  });

  it("retains a directly observed .nvm node when implicit home authentication fails", () => {
    const node = "/srv/isolated-home/.nvm/versions/node/v25.9.0/bin/node";
    platformMocks.homedir.mockReturnValue("/srv/isolated-home");
    platformMocks.userInfo.mockImplementationOnce(() => { throw new Error("lookup failed"); });

    expect(managedDaemonPathForStableLaunch(
      node,
      ["/opt/lcm/lcm.mjs", "daemon", "start"],
      "/var/lib/lcm",
    )).toBe(`/opt/lcm:${"/srv/isolated-home/.nvm/versions/node/v25.9.0/bin"}:${SYSTEMD_DAEMON_PATH}`);
  });

  it("withdraws implicit home trust when account lookup or home stat fails", () => {
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    platformMocks.homedir.mockReturnValue("/srv/isolated-home");
    platformMocks.userInfo.mockImplementationOnce(() => { throw new Error("lookup failed"); });
    platformMocks.statSync.mockReturnValue({
      uid,
      mode: 0o40700,
      isDirectory: () => true,
    } as ReturnType<typeof import("node:fs")["statSync"]>);
    const spawnArgs = [
      "/srv/isolated-home/.local/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
      "daemon",
      "start",
    ];
    expect(managedDaemonPathForStableLaunch(
      "/usr/bin/node",
      spawnArgs,
      "/var/lib/lcm",
    )).toBe(SYSTEMD_DAEMON_PATH);

    platformMocks.userInfo.mockReturnValue({
      username: "alice",
      uid,
      gid: 1000,
      shell: "/bin/sh",
      homedir: "/home/account",
    });
    platformMocks.statSync.mockImplementationOnce(() => { throw new Error("stat failed"); });
    expect(managedDaemonPathForStableLaunch(
      "/usr/bin/node",
      spawnArgs,
      "/var/lib/lcm",
    )).toBe(SYSTEMD_DAEMON_PATH);
  });

  it("keeps the explicit-home seam independent of implicit account lookup", () => {
    platformMocks.userInfo.mockImplementation(() => { throw new Error("lookup failed"); });
    platformMocks.statSync.mockImplementation(() => { throw new Error("stat failed"); });

    expect(managedDaemonPathForStableLaunch(
      "/usr/bin/node",
      [
        "/home/alice/.local/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
        "daemon",
        "start",
      ],
      "/var/lib/lcm",
      "/home/alice",
    )).toBe(`/home/alice/.local/bin:${SYSTEMD_DAEMON_PATH}`);
  });

  it("canonicalizes the explicit home and recognized prefix before comparison", () => {
    platformMocks.realpathSync.mockImplementation((path: string) =>
      path === "/home/alias" || path.startsWith("/home/alias/")
        ? path.replace("/home/alias", "/home/alice")
        : path
    );
    expect(managedDaemonPathForStableLaunch(
      "/usr/bin/node",
      [
        "/home/alias/.local/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
        "daemon",
        "start",
      ],
      "/var/lib/lcm",
      "/home/alice",
    )).toBe(`/home/alice/.local/bin:${SYSTEMD_DAEMON_PATH}`);
  });

  it("rejects a stable synthesized bin whose canonical path loses its recognized layout", () => {
    platformMocks.realpathSync.mockImplementation((path: string) =>
      path === "/home/alice/.local/bin"
        ? "/home/alice/work/project/renamed-prefix/bin"
        : path
    );
    expect(managedDaemonPathForStableLaunch(
      "/usr/bin/node",
      [
        "/home/alice/.local/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
        "daemon",
        "start",
      ],
      "/var/lib/lcm",
      "/home/alice",
    )).toBe(SYSTEMD_DAEMON_PATH);
  });

  it("preserves a directly observed absolute executable under an outside-home .local path", () => {
    expect(managedDaemonPathForStableLaunch(
      "/opt/app/.local/bin/lcm",
      ["daemon", "start", "--foreground"],
      "/var/lib/lcm",
      "/home/alice",
    )).toBe(`/opt/app/.local/bin:${SYSTEMD_DAEMON_PATH}`);
  });

  it("keeps non-stable checkout-local synthesis outside the caller cwd", () => {
    expect(managedDaemonPath(
      "/usr/bin/node",
      [
        "/work/project/.local/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs",
        "daemon",
        "start",
      ],
      "/work/other-project",
      "/home/alice",
    )).toBe(`/work/project/.local/bin:${SYSTEMD_DAEMON_PATH}`);
  });

  it("preserves a user-owned global npm prefix", () => {
    expect(managedDaemonPath(
      "/home/alice/.npm-packages/bin/node",
      ["/home/alice/.npm-packages/bin/lcm", "daemon", "start"],
    )).toBe(`/home/alice/.npm-packages/bin:${SYSTEMD_DAEMON_PATH}`);
  });

  it("recovers the trusted npm global bin from the packaged runtime", () => {
    expect(managedDaemonPath(
      "/usr/bin/node",
      ["/home/alice/.npm-global/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs", "daemon", "start"],
      "/work/project",
      "/home/alice",
    )).toBe(`/home/alice/.npm-global/bin:${SYSTEMD_DAEMON_PATH}`);
    expect(managedDaemonPath(
      "/usr/bin/node",
      ["/home/alice/.npm-global/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs", "daemon", "start"],
      "/home/alice",
      "/home/alice",
    )).toBe(`/home/alice/.npm-global/bin:${SYSTEMD_DAEMON_PATH}`);
  });

  it("does not derive npm bins for unrelated or project-contained packages", () => {
    expect(managedDaemonPath(
      "/usr/bin/node",
      ["/home/alice/.npm-global/lib/node_modules/other-package/dist/lcm.mjs", "daemon", "start"],
      "/work/project",
      "/home/alice",
    )).toBe(SYSTEMD_DAEMON_PATH);
    expect(managedDaemonPath(
      "/usr/bin/node",
      ["/work/project/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs", "daemon", "start"],
      "/work/project",
      "/home/alice",
    )).toBe(SYSTEMD_DAEMON_PATH);
    expect(managedDaemonPath(
      "/usr/bin/node",
      ["/work/project/.npm-global/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs", "daemon", "start"],
      "/work/project",
      "/home/alice",
    )).toBe(SYSTEMD_DAEMON_PATH);
    expect(managedDaemonPath(
      "/usr/bin/node",
      ["/home/alice/.npm:shadow/lib/node_modules/@donadiosolutions/lcm/dist/lcm.mjs", "daemon", "start"],
      "/work/project",
      "/home/alice",
    )).toBe(SYSTEMD_DAEMON_PATH);
  });

  it("preserves the bundled Codex Node runtime beside a plugin entrypoint", () => {
    expect(managedDaemonPath(
      "/opt/codex-desktop/resources/node-runtime/bin/node",
      ["/home/alice/.codex/plugins/cache/lcm/1.4.0/lcm.mjs", "daemon", "start"],
    )).toBe(
      `/home/alice/.codex/plugins/cache/lcm/1.4.0:/opt/codex-desktop/resources/node-runtime/bin:${SYSTEMD_DAEMON_PATH}`,
    );
  });

  it("rejects trusted executable directories containing the PATH delimiter", () => {
    expect(managedDaemonPath(
      "/opt/node:shadow/bin/node",
      ["/opt/lcm:shadow/lcm.mjs", "daemon", "start"],
    )).toBe(SYSTEMD_DAEMON_PATH);

    expect(managedDaemonPath(
      "/home/alice/.nvm/versions/node/v25.9.0/bin/node",
      ["/opt/lcm:shadow/lcm.mjs", "daemon", "start"],
    )).toBe(`/home/alice/.nvm/versions/node/v25.9.0/bin:${SYSTEMD_DAEMON_PATH}`);
  });
});
