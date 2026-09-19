import { afterEach, describe, expect, it, vi } from "vitest";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitManagedDaemonPeer,
  findListeningTcpPorts,
  parseProcessCommandLine,
  readPlatformProcessArguments,
  readPlatformProcessCommand,
  readPlatformProcessOwnerIdentity,
  readPlatformProcessOwnerUid,
} from "../../src/daemon/peer-admission.js";

describe("managed daemon peer admission", () => {
  const roots: string[] = [];
  const expectedEntrypoint = "/opt/lcm/lcm.mjs";
  const admit = (options: Parameters<typeof admitManagedDaemonPeer>[0]) => admitManagedDaemonPeer({
    expectedEntrypoint,
    ...options,
  });

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
      readProcessCommand: vi.fn(() => `${process.execPath} /opt/lcm/lcm.mjs daemon start`),
      readProcessArguments: vi.fn(() => [process.execPath, expectedEntrypoint, "daemon", "start"]),
      readProcessExecutable: vi.fn(() => process.execPath),
      readProcessOwnerUid: vi.fn(() => process.getuid?.() ?? null),
      readProcessOwnerIdentity: vi.fn(() => "S-1-5-21-1000"),
      findListeningTcpPorts: vi.fn(() => [3737]),
    };
  }

  it.each(["linux", "darwin", "win32"] as const)(
    "pins stable local process and listener evidence on %s",
    (platform) => {
      const seams = stableSeams();
      expect(admit({
        authority: pidAuthority(),
        port: 3737,
        platform,
        _seams: seams,
      })).toEqual({ pid: 42, birth: "birth-42" });
      expect(seams.isProcessAlive).toHaveBeenCalledTimes(2);
      expect(seams.processBirth).toHaveBeenCalledTimes(2);
      expect(seams.readProcessArguments).toHaveBeenCalledTimes(2);
      expect(seams.findListeningTcpPorts).toHaveBeenCalledTimes(2);
    },
  );

  it("fails closed when listener ownership changes during the stable recheck", () => {
    const seams = stableSeams();
    seams.findListeningTcpPorts
      .mockReturnValueOnce([3737])
      .mockReturnValueOnce([]);
    expect(admit({
      authority: pidAuthority(),
      port: 3737,
      platform: "linux",
      _seams: seams,
    })).toBeNull();
  });

  it("rejects a reused owned PID when a foreign entrypoint owns the listener", () => {
    const seams = stableSeams();
    seams.readProcessArguments.mockReturnValue([
      "/usr/bin/node",
      "/tmp/foreign-lcm.mjs",
      expectedEntrypoint,
      "daemon",
      "start",
    ]);
    expect(admit({
      authority: pidAuthority(),
      port: 3737,
      platform: "linux",
      _seams: seams,
    })).toBeNull();
    expect(seams.findListeningTcpPorts).not.toHaveBeenCalled();
  });

  it.each(["--eval=process.exit()", "--require=/tmp/foreign.cjs"])(
    "rejects Node preload or evaluation flag %s before the expected entrypoint",
    (flag) => {
      const seams = stableSeams();
      seams.readProcessArguments.mockReturnValue([
        "/usr/bin/node",
        flag,
        expectedEntrypoint,
        "daemon",
        "start",
      ]);
      expect(admit({
        authority: pidAuthority(),
        port: 3737,
        platform: "linux",
        _seams: seams,
      })).toBeNull();
    },
  );

  it("rejects a foreign executable named node even with exact accepted argv", () => {
    const seams = stableSeams();
    seams.readProcessArguments.mockReturnValue([
      "/tmp/node",
      expectedEntrypoint,
      "daemon",
      "start",
    ]);
    seams.readProcessExecutable.mockReturnValue("/tmp/node");
    expect(admit({
      authority: pidAuthority(),
      port: 3737,
      platform: "linux",
      _seams: seams,
    })).toBeNull();
  });

  it("accepts a directly executable managed entrypoint", () => {
    const seams = stableSeams();
    seams.readProcessArguments.mockReturnValue([expectedEntrypoint, "daemon", "start"]);
    seams.readProcessExecutable.mockReturnValue(expectedEntrypoint);
    expect(admit({
      authority: pidAuthority(),
      port: 3737,
      platform: "linux",
      _seams: seams,
    })).toEqual({ pid: 42, birth: "birth-42" });
  });

  it("rejects a reused PID owned by a different POSIX user", () => {
    const seams = stableSeams();
    const currentUid = process.getuid?.();
    if (currentUid === undefined) return;
    seams.readProcessOwnerUid.mockReturnValue(currentUid + 1);
    expect(admit({
      authority: pidAuthority(),
      port: 3737,
      platform: "linux",
      _seams: seams,
    })).toBeNull();
    expect(seams.readProcessArguments).not.toHaveBeenCalled();
    expect(seams.findListeningTcpPorts).not.toHaveBeenCalled();
  });

  it("preserves manager authority without imposing PID-file owner evidence", () => {
    const seams = stableSeams();
    seams.readProcessOwnerUid.mockReturnValue(999_999);
    expect(admit({
      authority: { kind: "manager", pid: 42, revalidate: () => true },
      port: 3737,
      platform: "linux",
      _seams: seams,
    })).toEqual({ pid: 42, birth: "birth-42" });
    expect(seams.readProcessOwnerUid).not.toHaveBeenCalled();
  });

  it("binds Windows PID-file authority to the current process owner SID", () => {
    const authority = { ...pidAuthority(), expectedUid: undefined };
    const seams = stableSeams();
    seams.readProcessArguments.mockReturnValue([
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\LCM App\\lcm.mjs",
      "daemon",
      "start",
    ]);
    seams.readProcessOwnerIdentity.mockImplementation((pid) => (
      pid === process.pid ? "S-1-5-21-1000" : "S-1-5-21-2000"
    ));
    expect(admitManagedDaemonPeer({
      authority,
      port: 3737,
      platform: "win32",
      expectedEntrypoint: "C:\\LCM App\\lcm.mjs",
      _seams: seams,
    })).toBeNull();
    seams.readProcessOwnerIdentity.mockReturnValue("S-1-5-21-1000");
    expect(admitManagedDaemonPeer({
      authority,
      port: 3737,
      platform: "win32",
      expectedEntrypoint: "C:\\LCM App\\lcm.mjs",
      _seams: seams,
    })).toEqual({ pid: 42, birth: "birth-42" });
  });

  it("fails closed when process birth changes during the stable recheck", () => {
    const seams = stableSeams();
    seams.processBirth
      .mockReturnValueOnce("birth-before")
      .mockReturnValueOnce("birth-after");
    expect(admit({
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
    expect(admit({
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
    expect(admit({
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
    expect(admit({
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
    ["missing command", { readProcessArguments: () => null }],
    ["foreign command", { readProcessArguments: () => ["node", "other", "start"] }],
    ["missing listener", { findListeningTcpPorts: () => [] }],
  ])("fails closed for %s evidence", (_label, override) => {
    const seams = { ...stableSeams(), ...override };
    expect(admit({
      authority: pidAuthority(),
      port: 3737,
      platform: "linux",
      _seams: seams,
    })).toBeNull();
  });

  it("rejects manager authority before process inspection when its first witness is stale", () => {
    const seams = stableSeams();
    expect(admit({
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
    seams.readProcessArguments.mockImplementationOnce(() => {
      writeFileSync(authority.pidFilePath, "43\n", { mode: 0o600 });
      return ["/usr/bin/node", expectedEntrypoint, "daemon", "start"];
    });
    expect(admit({
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
    writeFileSync(join(processRoot, "cmdline"), `node\0${expectedEntrypoint}\0daemon\0start\0`);
    symlinkSync(process.execPath, join(processRoot, "exe"));
    writeFileSync(
      join(processRoot, "status"),
      `Name:\tnode\nUid:\t${String(process.getuid?.() ?? 1000)}\t${String(process.getuid?.() ?? 1000)}\t${String(process.getuid?.() ?? 1000)}\t${String(process.getuid?.() ?? 1000)}\n`,
    );
    symlinkSync("socket:[123]", join(processRoot, "fd", "1"));
    writeFileSync(join(procRoot, "net", "tcp"), [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:0E99 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 123 1 0000000000000000",
    ].join("\n"));
    writeFileSync(join(procRoot, "net", "tcp6"), "");

    expect(admit({
      authority: { kind: "pid-file", pidFilePath, expectedUid: process.getuid?.() },
      port: 3737,
      platform: "linux",
      procRoot,
    })).toEqual({ pid, birth: expect.any(String) });
  });

  it("uses the default liveness probe to reject an absent PID", () => {
    expect(admit({
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

  it("parses quoted platform command lines without treating substrings as argv", () => {
    expect(parseProcessCommandLine(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\LCM App\\lcm.mjs" daemon start --foreground',
      "win32",
    )).toEqual([
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\LCM App\\lcm.mjs",
      "daemon",
      "start",
      "--foreground",
    ]);
    expect(parseProcessCommandLine(
      'node "/opt/LCM App/lcm.mjs" daemon start',
      "darwin",
    )).toEqual(["node", "/opt/LCM App/lcm.mjs", "daemon", "start"]);
    expect(parseProcessCommandLine('node "unterminated', "darwin")).toBeNull();
  });

  it("reads a bounded POSIX process owner", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-peer-owner-"));
    roots.push(root);
    const processRoot = join(root, "42");
    mkdirSync(processRoot, { recursive: true });
    writeFileSync(join(processRoot, "status"), "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\n");
    expect(readPlatformProcessOwnerUid(42, "linux", vi.fn() as never, root)).toBe(1000);
    writeFileSync(join(processRoot, "status"), "Name:\tnode\nUid:\tbroken\n");
    expect(readPlatformProcessOwnerUid(42, "linux", vi.fn() as never, root)).toBeNull();
  });

  it("reads lossless Darwin procargs and a bounded Windows owner SID", () => {
    const darwinPayload = Buffer.concat([
      Buffer.from(Uint32Array.of(4).buffer),
      Buffer.from("/usr/bin/node\0\0"),
      Buffer.from("/usr/bin/node\0/opt/LCM App/lcm.mjs\0daemon\0start\0"),
    ]);
    const darwin = vi.fn(() => ({ status: 0, stdout: darwinPayload }));
    expect(readPlatformProcessArguments(42, "darwin", darwin as never)).toEqual([
      "/usr/bin/node",
      "/opt/LCM App/lcm.mjs",
      "daemon",
      "start",
    ]);
    expect(darwin).toHaveBeenCalledWith(
      "/usr/sbin/sysctl",
      ["-b", "kern.procargs2.42"],
      expect.objectContaining({ encoding: "buffer", shell: false }),
    );

    const windows = vi.fn(() => ({ status: 0, stdout: "s-1-5-21-1000" }));
    expect(readPlatformProcessOwnerIdentity(
      42,
      "win32",
      windows as never,
      "/proc",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    )).toBe("S-1-5-21-1000");
  });
});
