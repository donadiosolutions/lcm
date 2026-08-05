import { describe, expect, it } from "vitest";
import {
  managedDaemonPath,
  managedDaemonPathForStableLaunch,
  SYSTEMD_DAEMON_PATH,
} from "../../src/daemon/managed-path.js";

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
