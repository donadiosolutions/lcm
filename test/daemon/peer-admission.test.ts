import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, linkSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { admitDaemonPeer } from "../../src/daemon/peer-admission.js";
import { readPlatformProcessCommand } from "../../src/daemon/peer-attribution.js";

const pid = 4242;
const port = 3737;
const roots: string[] = [];

function fixture(): { homeDir: string; _procRoot: string; pidPath: string; statusPath: string; tcpPath: string } {
  const homeDir = mkdtempSync(join(tmpdir(), "lcm-peer-admission-"));
  roots.push(homeDir);
  const stateDir = join(homeDir, ".lcm");
  const procRoot = join(homeDir, "proc");
  const processDir = join(procRoot, String(pid));
  mkdirSync(stateDir, { mode: 0o700 });
  mkdirSync(join(processDir, "fd"), { recursive: true });
  mkdirSync(join(procRoot, "net"));
  const pidPath = join(stateDir, "daemon.pid");
  writeFileSync(pidPath, String(pid), { mode: 0o600 });
  const statusPath = join(processDir, "status");
  writeFileSync(statusPath, `Name:\tlcm\nUid:\t${process.getuid!()}\t${process.getuid!()}\t${process.getuid!()}\t${process.getuid!()}\n`);
  writeFileSync(join(processDir, "cmdline"), "node\0/opt/lcm.mjs\0daemon\0start\0");
  symlinkSync("socket:[123]", join(processDir, "fd", "5"));
  const tcpPath = join(procRoot, "net", "tcp");
  writeFileSync(tcpPath, "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n"
    + "0: 0100007F:0E99 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 123\n");
  writeFileSync(join(procRoot, "net", "tcp6"), "sl local_address rem_address st\n");
  return { homeDir, _procRoot: procRoot, pidPath, statusPath, tcpPath };
}

const birth = vi.fn(() => "birth");
const deadline = () => performance.now() + 2_000;

afterEach(() => {
  birth.mockReset().mockReturnValue("birth");
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("daemon peer admission", () => {
  it("admits only the private PID that owns the exact loopback listener", () => {
    const paths = fixture();
    expect(admitDaemonPeer({ ...paths, port, deadline: deadline(), _processBirth: birth })).toEqual({ pid, birth: "birth" });
    expect(birth).toHaveBeenCalledTimes(2);
  });

  it("refuses a foreign process even when its PID file and listener agree", () => {
    const paths = fixture();
    writeFileSync(paths.statusPath, `Uid:\t${process.getuid!() + 1}\n`);
    expect(admitDaemonPeer({ ...paths, port, deadline: deadline(), _processBirth: birth })).toBeNull();
  });

  it("refuses missing, malformed, and public PID evidence", () => {
    const paths = fixture();
    writeFileSync(paths.pidPath, `${pid}\n`);
    expect(admitDaemonPeer({ ...paths, port, deadline: deadline(), _processBirth: birth })).toBeNull();
    writeFileSync(paths.pidPath, String(pid));
    chmodSync(paths.pidPath, 0o644);
    expect(admitDaemonPeer({ ...paths, port, deadline: deadline(), _processBirth: birth })).toBeNull();
    chmodSync(paths.pidPath, 0o600);
    linkSync(paths.pidPath, join(paths.homeDir, ".lcm", "other-pid"));
    expect(admitDaemonPeer({ ...paths, port, deadline: deadline(), _processBirth: birth })).toBeNull();
  });

  it("refuses a foreign listener and a changing process birth", () => {
    const paths = fixture();
    writeFileSync(paths.tcpPath, "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n"
      + "0: 0200007F:0E99 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 123\n");
    expect(admitDaemonPeer({ ...paths, port, deadline: deadline(), _processBirth: birth })).toBeNull();
    writeFileSync(paths.tcpPath, "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n"
      + "0: 0100007F:0E99 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 123\n");
    birth.mockReturnValueOnce("old").mockReturnValueOnce("new");
    expect(admitDaemonPeer({ ...paths, port, deadline: deadline(), _processBirth: birth })).toBeNull();
  });

  it("accepts a verified manager transition with no PID file and rejects conflicting state", () => {
    const paths = fixture();
    rmSync(paths.pidPath);
    expect(admitDaemonPeer({ ...paths, port, deadline: deadline(), _processBirth: birth,
      manager: { pid } })).toEqual({ pid, birth: "birth" });
    writeFileSync(paths.pidPath, "9999", { mode: 0o600 });
    expect(admitDaemonPeer({ ...paths, port, deadline: deadline(), _processBirth: birth,
      manager: { pid } })).toBeNull();
  });

  it("uses bounded numeric Darwin owner and listener witnesses", () => {
    const paths = fixture();
    const spawn = vi.fn((_command: string, args: string[]) => ({
      status: 0,
      stdout: args.includes("uid=") ? String(process.getuid!())
        : args.includes("command=") ? "node /opt/lcm.mjs daemon start"
          : "p4242\nn127.0.0.1:3737\n",
      stderr: "",
    }));
    expect(admitDaemonPeer({ ...paths, port, deadline: deadline(), _processBirth: birth,
      _platform: "darwin", _spawnSync: spawn as never })).toEqual({ pid, birth: "birth" });
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it("fails closed without Windows SID/ACL proof or remaining budget", () => {
    const paths = fixture();
    expect(admitDaemonPeer({ ...paths, port, deadline: deadline(), _platform: "win32" })).toBeNull();
    expect(admitDaemonPeer({ ...paths, port, deadline: performance.now() - 1 })).toBeNull();
  });

  it("refuses invalid process birth, UID data, and daemon command", () => {
    const paths = fixture();
    birth.mockReturnValueOnce(null);
    expect(admitDaemonPeer({ ...paths, port, deadline: deadline(), _processBirth: birth })).toBeNull();
    writeFileSync(paths.statusPath, "Uid:\tunknown\n");
    expect(admitDaemonPeer({ ...paths, port, deadline: deadline(), _processBirth: birth })).toBeNull();
    writeFileSync(paths.statusPath, `Uid:\t${process.getuid!()}\n`);
    writeFileSync(join(paths._procRoot, String(pid), "cmdline"), "node\0other\0");
    expect(admitDaemonPeer({ ...paths, port, deadline: deadline(), _processBirth: birth })).toBeNull();
  });

  it("refuses unsafe private roots and PID changes during attribution", () => {
    const paths = fixture();
    chmodSync(join(paths.homeDir, ".lcm"), 0o755);
    expect(admitDaemonPeer({ ...paths, port, deadline: deadline(), _processBirth: birth })).toBeNull();
    chmodSync(join(paths.homeDir, ".lcm"), 0o700);
    writeFileSync(paths.pidPath, "9007199254740992");
    expect(admitDaemonPeer({ ...paths, port, deadline: deadline(), _processBirth: birth })).toBeNull();
    writeFileSync(paths.pidPath, String(pid));
    const replacement = join(paths.homeDir, ".lcm", "replacement.pid");
    writeFileSync(replacement, String(pid), { mode: 0o600 });
    birth.mockImplementationOnce(() => { renameSync(replacement, paths.pidPath); return "birth"; });
    expect(admitDaemonPeer({ ...paths, port, deadline: deadline(), _processBirth: birth })).toBeNull();
  });

  it("refuses a manager whose absent PID state reappears with a different PID", () => {
    const paths = fixture();
    rmSync(paths.pidPath);
    birth.mockImplementationOnce(() => {
      writeFileSync(paths.pidPath, "9999", { mode: 0o600 });
      return "birth";
    });
    expect(admitDaemonPeer({ ...paths, port, deadline: deadline(), _processBirth: birth,
      manager: { pid } })).toBeNull();
  });

  it("refuses malformed Darwin process-owner observations", () => {
    const paths = fixture();
    const spawn = vi.fn(() => ({ status: 0, stdout: "not-a-uid", stderr: "" }));
    expect(admitDaemonPeer({ ...paths, port, deadline: deadline(), _processBirth: birth,
      _platform: "darwin", _spawnSync: spawn as never })).toBeNull();
    spawn.mockReturnValue({ status: 1, stdout: String(process.getuid!()), stderr: "" });
    expect(admitDaemonPeer({ ...paths, port, deadline: deadline(), _processBirth: birth,
      _platform: "darwin", _spawnSync: spawn as never })).toBeNull();
  });

  it("bounds Darwin subprocess time before reading the listener", () => {
    const paths = fixture();
    let now = 0;
    const spawn = vi.fn((_command: string, args: string[]) => {
      if (args.includes("uid=")) return { status: 0, stdout: String(process.getuid!()), stderr: "" };
      now = 100;
      return { status: 0, stdout: "node /opt/lcm.mjs daemon start", stderr: "" };
    });
    expect(admitDaemonPeer({ ...paths, port, deadline: 100, now: () => now,
      _processBirth: birth, _platform: "darwin", _spawnSync: spawn as never })).toBeNull();
  });

  it("resolves the default private home and refuses platforms without owner proof", () => {
    const paths = fixture();
    vi.stubEnv("HOME", paths.homeDir);
    expect(admitDaemonPeer({ port, deadline: deadline(), _procRoot: paths._procRoot,
      _processBirth: birth })).toEqual({ pid, birth: "birth" });
    expect(admitDaemonPeer({ ...paths, port, deadline: deadline(), _processBirth: birth,
      _platform: "freebsd" })).toBeNull();
  });

  it("refuses unavailable Darwin owner output and native command mismatch", () => {
    const paths = fixture();
    const noOutput = vi.fn(() => ({ status: 0, stdout: undefined, stderr: "" }));
    expect(admitDaemonPeer({ ...paths, port, deadline: deadline(), _processBirth: birth,
      _platform: "darwin", _spawnSync: noOutput as never })).toBeNull();
    writeFileSync(paths.pidPath, String(process.pid));
    expect(admitDaemonPeer({ ...paths, port, deadline: deadline(), _processBirth: birth,
      _platform: "darwin" })).toBeNull();
  });

  it("refuses a budget that expires exactly before a platform command", () => {
    const paths = fixture();
    let calls = 0;
    const now = () => (++calls < 7 ? 0 : 100);
    const spawn = vi.fn(() => ({ status: 0, stdout: String(process.getuid!()), stderr: "" }));
    expect(admitDaemonPeer({ ...paths, port, deadline: 100, now,
      _processBirth: birth, _platform: "darwin", _spawnSync: spawn as never })).toBeNull();
  });

  it("refuses PID evidence that becomes unsafe on the final descriptor read", () => {
    const paths = fixture();
    birth.mockImplementationOnce(() => { chmodSync(paths.pidPath, 0o644); return "birth"; });
    expect(admitDaemonPeer({ ...paths, port, deadline: deadline(), _processBirth: birth })).toBeNull();
  });
});

describe("platform command attribution", () => {
  it("uses only a supplied trusted Windows command path and rejects unsupported platforms", () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: "node lcm daemon start", stderr: "" }));
    expect(readPlatformProcessCommand(pid, "win32", spawn as never, "/proc", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"))
      .toBe("node lcm daemon start");
    expect(spawn).toHaveBeenCalledOnce();
    expect(readPlatformProcessCommand(pid, "aix", spawn as never)).toBeNull();
    expect(readPlatformProcessCommand(pid, "win32", spawn as never, "/proc", null)).toBeNull();
  });

  it("refuses failed, empty, and throwing command probes", () => {
    const spawn = vi.fn(() => ({ status: 1, stdout: "node lcm daemon start", stderr: "" }));
    expect(readPlatformProcessCommand(pid, "darwin", spawn as never)).toBeNull();
    spawn.mockReturnValue({ status: 0, stdout: " ", stderr: "" });
    expect(readPlatformProcessCommand(pid, "darwin", spawn as never)).toBeNull();
    spawn.mockImplementation(() => { throw new Error("probe unavailable"); });
    expect(readPlatformProcessCommand(pid, "darwin", spawn as never)).toBeNull();
  });
});
