import { describe, expect, it } from "vitest";
import { managedDaemonPath, SYSTEMD_DAEMON_PATH } from "../../src/daemon/managed-path.js";

describe("managed daemon executable path", () => {
  it("prepends the directory of an absolute Node-launched LCM entrypoint", () => {
    expect(managedDaemonPath(
      "/usr/bin/node",
      ["/home/alice/.nvm/versions/node/v25.9.0/bin/lcm", "daemon", "start", "--foreground"],
    )).toBe(`/home/alice/.nvm/versions/node/v25.9.0/bin:${SYSTEMD_DAEMON_PATH}`);

    expect(managedDaemonPath(
      "/usr/bin/node",
      ["/opt/lcm/plugin/lcm.mjs", "daemon", "start", "--foreground"],
    )).toBe(`/opt/lcm/plugin:${SYSTEMD_DAEMON_PATH}`);
  });

  it("uses an absolute directly executed LCM command and deduplicates system directories", () => {
    expect(managedDaemonPath("/usr/local/bin/lcm", ["daemon", "start", "--foreground"]))
      .toBe("/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin");
  });

  it("falls back to fixed system directories for missing or relative entrypoints", () => {
    expect(managedDaemonPath("node", ["lcm", "daemon", "start"])).toBe(SYSTEMD_DAEMON_PATH);
    expect(managedDaemonPath("/usr/bin/node", [])).toBe(SYSTEMD_DAEMON_PATH);
    expect(managedDaemonPath("lcm", ["daemon", "start"])).toBe(SYSTEMD_DAEMON_PATH);
  });
});
