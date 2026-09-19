import { afterEach, describe, expect, it, vi } from "vitest";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitManagedDaemonPeer,
  findListeningTcpPorts,
  readPlatformProcessCommand,
} from "../../src/daemon/peer-admission.js";

describe("managed daemon peer admission", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function pidAuthority(pid = 42) {
    const root = mkdtempSync(join(tmpdir(), "lcm-peer-admission-"));
    roots.push(root);
    const pidFilePath = join(root, "daemon.pid");
    writeFileSync(pidFilePath, `${pid}\n`, { mode: 0o600 });
    return { kind: "pid-file" as const, pidFilePath, expectedUid: process.getuid?.() };
  }

  function stableSeams() {
    return {
      isProcessAlive: vi.fn(() => true),
      processBirth: vi.fn(() => "birth-42"),
      readProcessCommand: vi.fn(() => "/usr/bin/node /opt/lcm/lcm.mjs daemon start"),
      findListeningTcpPorts: vi.fn(() => [3737]),
    };
  }

  it.each(["linux", "darwin", "win32"] as const)(
    "pins stable local process and listener evidence on %s",
    (platform) => {
      const seams = stableSeams();
      expect(admitManagedDaemonPeer({
        authority: pidAuthority(),
        port: 3737,
        platform,
        _seams: seams,
      })).toEqual({ pid: 42, birth: "birth-42" });
      expect(seams.isProcessAlive).toHaveBeenCalledTimes(2);
      expect(seams.processBirth).toHaveBeenCalledTimes(2);
      expect(seams.readProcessCommand).toHaveBeenCalledTimes(2);
      expect(seams.findListeningTcpPorts).toHaveBeenCalledTimes(2);
    },
  );

  it("fails closed when listener ownership changes during the stable recheck", () => {
    const seams = stableSeams();
    seams.findListeningTcpPorts
      .mockReturnValueOnce([3737])
      .mockReturnValueOnce([]);
    expect(admitManagedDaemonPeer({
      authority: pidAuthority(),
      port: 3737,
      platform: "linux",
      _seams: seams,
    })).toBeNull();
  });

  it("fails closed when process birth changes during the stable recheck", () => {
    const seams = stableSeams();
    seams.processBirth
      .mockReturnValueOnce("birth-before")
      .mockReturnValueOnce("birth-after");
    expect(admitManagedDaemonPeer({
      authority: pidAuthority(),
      port: 3737,
      platform: "linux",
      _seams: seams,
    })).toBeNull();
  });

  it("rejects a multiply-linked PID leaf before inspecting the process", () => {
    const authority = pidAuthority();
    linkSync(authority.pidFilePath, `${authority.pidFilePath}.alias`);
    const seams = stableSeams();
    expect(admitManagedDaemonPeer({
      authority,
      port: 3737,
      platform: "linux",
      _seams: seams,
    })).toBeNull();
    expect(seams.isProcessAlive).not.toHaveBeenCalled();
  });

  it("preserves current manager authority without requiring a stale PID file", () => {
    const seams = stableSeams();
    const revalidate = vi.fn(() => true);
    expect(admitManagedDaemonPeer({
      authority: { kind: "manager", pid: 42, revalidate, systemdControlGroup: "/user.slice/lcm.service" },
      port: 3737,
      platform: "linux",
      _seams: seams,
    })).toEqual({ pid: 42, birth: "birth-42" });
    expect(revalidate).toHaveBeenCalledTimes(2);
  });

  it("fails closed when manager authority becomes ambiguous", () => {
    const seams = stableSeams();
    const revalidate = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    expect(admitManagedDaemonPeer({
      authority: { kind: "manager", pid: 42, revalidate },
      port: 3737,
      platform: "linux",
      _seams: seams,
    })).toBeNull();
  });

  it("rejects invalid ports and malformed PID evidence before process inspection", () => {
    const authority = pidAuthority();
    const seams = stableSeams();
    expect(admitManagedDaemonPeer({ authority, port: 0, _seams: seams })).toBeNull();
    writeFileSync(authority.pidFilePath, "42 trailing\n", { mode: 0o600 });
    expect(admitManagedDaemonPeer({ authority, port: 3737, _seams: seams })).toBeNull();
    expect(seams.isProcessAlive).not.toHaveBeenCalled();
  });

  it.each([
    ["dead process", { isProcessAlive: () => false }],
    ["missing birth", { processBirth: () => null }],
    ["missing command", { readProcessCommand: () => null }],
    ["foreign command", { readProcessCommand: () => "node other start" }],
    ["missing listener", { findListeningTcpPorts: () => [] }],
  ])("fails closed for %s evidence", (_label, override) => {
    const seams = { ...stableSeams(), ...override };
    expect(admitManagedDaemonPeer({
      authority: pidAuthority(),
      port: 3737,
      platform: "linux",
      _seams: seams,
    })).toBeNull();
  });

  it("rejects manager authority before process inspection when its first witness is stale", () => {
    const seams = stableSeams();
    expect(admitManagedDaemonPeer({
      authority: { kind: "manager", pid: 42, revalidate: () => false },
      port: 3737,
      platform: "linux",
      _seams: seams,
    })).toBeNull();
    expect(seams.isProcessAlive).not.toHaveBeenCalled();
  });

  it("rejects PID contents replaced between the two stable reads", () => {
    const authority = pidAuthority();
    const seams = stableSeams();
    seams.readProcessCommand.mockImplementationOnce(() => {
      writeFileSync(authority.pidFilePath, "43\n", { mode: 0o600 });
      return "/usr/bin/node /opt/lcm/lcm.mjs daemon start";
    });
    expect(admitManagedDaemonPeer({
      authority,
      port: 3737,
      platform: "linux",
      _seams: seams,
    })).toBeNull();
  });

  it("uses the default Linux liveness, birth, command, and listener probes", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-peer-defaults-"));
    roots.push(root);
    const pid = process.pid;
    const pidFilePath = join(root, "daemon.pid");
    const procRoot = join(root, "proc");
    const processRoot = join(procRoot, String(pid));
    mkdirSync(join(processRoot, "fd"), { recursive: true });
    mkdirSync(join(procRoot, "net"), { recursive: true });
    writeFileSync(pidFilePath, `${String(pid)}\n`, { mode: 0o600 });
    writeFileSync(join(processRoot, "cmdline"), "node\0/opt/lcm.mjs\0daemon\0start\0");
    symlinkSync("socket:[123]", join(processRoot, "fd", "1"));
    writeFileSync(join(procRoot, "net", "tcp"), [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:0E99 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 123 1 0000000000000000",
    ].join("\n"));
    writeFileSync(join(procRoot, "net", "tcp6"), "");

    expect(admitManagedDaemonPeer({
      authority: { kind: "pid-file", pidFilePath, expectedUid: process.getuid?.() },
      port: 3737,
      platform: "linux",
      procRoot,
    })).toEqual({ pid, birth: expect.any(String) });
  });

  it("uses the default liveness probe to reject an absent PID", () => {
    expect(admitManagedDaemonPeer({
      authority: pidAuthority(999_999_999),
      port: 3737,
      platform: "linux",
    })).toBeNull();
  });

  it("covers portable process-command success, absence, and execution failure", () => {
    const darwin = vi.fn(() => ({ status: 0, stdout: "node lcm daemon start\n" }));
    expect(readPlatformProcessCommand(42, "darwin", darwin as never)).toBe("node lcm daemon start");
    expect(readPlatformProcessCommand(42, "freebsd", vi.fn() as never)).toBeNull();
    expect(readPlatformProcessCommand(42, "win32", vi.fn(() => ({
      status: 0,
      stdout: "node lcm daemon start",
    })) as never, "/proc", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"))
      .toBe("node lcm daemon start");
    expect(readPlatformProcessCommand(42, "darwin", vi.fn(() => ({ status: 1, stdout: "ignored" })) as never))
      .toBeNull();
    expect(readPlatformProcessCommand(42, "darwin", vi.fn(() => ({ status: 0, stdout: "" })) as never))
      .toBeNull();
    expect(readPlatformProcessCommand(42, "darwin", vi.fn(() => { throw new Error("ps failed"); }) as never))
      .toBeNull();
    expect(findListeningTcpPorts(42, "darwin", vi.fn(() => ({
      status: 0,
      stdout: "n127.0.0.1:invalid\nn127.0.0.1:3737",
    })) as never)).toEqual([3737]);
  });
});
