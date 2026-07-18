import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fs = vi.hoisted(() => ({
  chmod: vi.fn(), exists: vi.fn(), mkdtemp: vi.fn(), read: vi.fn(), readdir: vi.fn(),
  rm: vi.fn(), stat: vi.fn(), unlink: vi.fn(), write: vi.fn(),
}));
vi.mock("node:fs", async importOriginal => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  chmodSync: fs.chmod, existsSync: fs.exists, mkdtempSync: fs.mkdtemp, readFileSync: fs.read,
  readdirSync: fs.readdir, rmSync: fs.rm, statSync: fs.stat, unlinkSync: fs.unlink, writeFileSync: fs.write,
}));

import { ensureDaemon } from "../../src/daemon/lifecycle.js";

const saved = { anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY, lcm: process.env.LCM_SUMMARY_API_KEY };
beforeEach(() => {
  vi.clearAllMocks(); fs.exists.mockImplementation((path: string) => path.endsWith("daemon.token")); fs.mkdtemp.mockReturnValue("/run/user/1000/lcm-systemd-credentials-test");
  fs.stat.mockReturnValue({ isDirectory: () => true, mtimeMs: 0 }); fs.readdir.mockReturnValue([]);
  delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.LCM_SUMMARY_API_KEY;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (saved.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.anthropic;
  if (saved.openai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.openai;
  if (saved.lcm === undefined) delete process.env.LCM_SUMMARY_API_KEY; else process.env.LCM_SUMMARY_API_KEY = saved.lcm;
});

const base = () => ({
  port: 1, pidFilePath: "/runtime/daemon.pid", spawnTimeoutMs: 1, _platform: "linux" as const,
  enforceUserManagerParent: true, _fetchOverride: vi.fn().mockRejectedValue(new Error("down")),
  _spawnOverride: vi.fn(() => ({ pid: undefined, once: vi.fn(), unref: vi.fn() })) as never,
  _skipHealthWait: true,
});

describe("mocked systemd credential boundaries", () => {
  it("starts with no secret credentials", async () => {
    const spawnSync = vi.fn(() => ({ status: 0 }));
    const result = await ensureDaemon({ ...base(), _spawnSyncOverride: spawnSync as never });
    expect(result.startMethod).toBe("systemd-user");
    expect(fs.mkdtemp).not.toHaveBeenCalled();
  });

  it("reports an unavailable uid", async () => {
    process.env.ANTHROPIC_API_KEY = "secret";
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    try {
      const result = await ensureDaemon(base());
      expect(result.warning).toContain("current user id is unavailable");
    } finally {
      if (descriptor) Object.defineProperty(process, "getuid", descriptor);
    }
  });

  it("reports a non-directory runtime path", async () => {
    process.env.ANTHROPIC_API_KEY = "secret";
    fs.stat.mockReturnValue({ isDirectory: () => false, mtimeMs: 0 });
    const result = await ensureDaemon(base());
    expect(result.warning).toContain("is not a directory");
  });

  it("cleans a partially created credential directory after write failure", async () => {
    process.env.ANTHROPIC_API_KEY = "secret";
    fs.readdir.mockReturnValue([
      { isDirectory: () => false, name: "file" },
      { isDirectory: () => true, name: "other" },
      { isDirectory: () => true, name: "lcm-systemd-credentials-old" },
    ]);
    fs.write.mockImplementation((path: string) => {
      if (path.includes("lcm-systemd-credentials-test")) throw "write failed";
    });
    const result = await ensureDaemon(base());
    expect(result.warning).toContain("write failed");
    expect(fs.rm).toHaveBeenCalledWith("/run/user/1000/lcm-systemd-credentials-test", { recursive: true, force: true });
  });

  it("does not attempt partial cleanup when credential directory creation fails", async () => {
    process.env.ANTHROPIC_API_KEY = "secret";
    fs.mkdtemp.mockImplementation(() => { throw new Error("mkdir failed"); });
    const result = await ensureDaemon(base());
    expect(result.warning).toContain("mkdir failed");
    expect(fs.rm).not.toHaveBeenCalledWith("/run/user/1000/lcm-systemd-credentials-test", expect.anything());
  });

  it("tolerates cleanup scan stat/removal failures", async () => {
    process.env.ANTHROPIC_API_KEY = "secret";
    fs.readdir.mockReturnValue([{ isDirectory: () => true, name: "lcm-systemd-credentials-old" }]);
    fs.stat.mockImplementation((path: string) => path === "/run/user/1000"
      ? { isDirectory: () => true, mtimeMs: 0 }
      : (() => { throw new Error("stat"); })());
    fs.write.mockImplementation(() => {});
    const result = await ensureDaemon({ ...base(), _spawnSyncOverride: vi.fn(() => ({ status: 0 })) as never });
    expect(result.startMethod).toBe("systemd-user");
    expect(fs.rm).toHaveBeenCalledWith("/run/user/1000/lcm-systemd-credentials-test", { recursive: true, force: true });
  });

  it("cleans credentials after a systemd-started daemon becomes healthy", async () => {
    process.env.ANTHROPIC_API_KEY = "secret";
    fs.read.mockImplementation((path: string) => {
      if (path.endsWith("daemon.token")) return "token";
      throw new Error("missing pid");
    });
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error("initially down"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const result = await ensureDaemon({
      ...base(), _skipHealthWait: false, _fetchOverride: fetch,
      _spawnSyncOverride: vi.fn(() => ({ status: 0 })) as never, _sleepOverride: async () => {},
    });
    expect(result).toMatchObject({ connected: true, startMethod: "systemd-user" });
    expect(fs.rm).toHaveBeenCalledWith("/run/user/1000/lcm-systemd-credentials-test", { recursive: true, force: true });
  });

  it("tolerates credential cleanup removal failures and Error-valued systemd throws", async () => {
    process.env.ANTHROPIC_API_KEY = "secret";
    fs.rm.mockImplementation(() => { throw new Error("remove"); });
    const result = await ensureDaemon({
      ...base(),
      _spawnSyncOverride: vi.fn(() => { throw new Error("systemd error"); }) as never,
    });
    expect(result.warning).toContain("systemd error");
  });

  it("does not terminate when a verified retry PID changes identity before signaling", async () => {
    let daemonCommandReads = 0;
    fs.exists.mockReturnValue(true);
    fs.readdir.mockReturnValue([{ isDirectory: () => true, name: "11" }]);
    fs.read.mockImplementation((path: string) => {
      if (path.endsWith("daemon.pid")) return "20";
      if (path.endsWith("/11/status")) return "Uid:\t1000\nPPid:\t1\n";
      if (path.endsWith("/11/cmdline")) return "systemd\0--user";
      if (path.endsWith("/20/status")) return "Uid:\t1000\nPPid:\t10\n";
      if (path.endsWith("/20/cmdline")) {
        daemonCommandReads++;
        return daemonCommandReads === 1 ? "node\0lcm\0daemon\0start\0--foreground" : "node\0other";
      }
      if (path.endsWith("daemon.token")) return "token";
      throw new Error(`unexpected read ${path}`);
    });
    const kill = vi.fn();
    const result = await ensureDaemon({
      ...base(), _procRoot: "/proc", _uid: 1000, _skipSpawn: true, _skipHealthWait: false,
      _isProcessAliveOverride: () => true, _killOverride: kill, _sleepOverride: async () => {},
    });
    expect(result.connected).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not terminate when an existing healthy PID changes identity before signaling", async () => {
    let daemonCommandReads = 0;
    fs.exists.mockImplementation((path: string) => path.endsWith("daemon.token"));
    fs.readdir.mockReturnValue([{ isDirectory: () => true, name: "10" }]);
    fs.read.mockImplementation((path: string) => {
      if (path.endsWith("daemon.pid")) return "20";
      if (path.endsWith("/10/status")) return "Uid:\t1000\nPPid:\t1\n";
      if (path.endsWith("/10/cmdline")) return "systemd\0--user";
      if (path.endsWith("/20/status")) return "Uid:\t1000\nPPid:\t10\n";
      if (path.endsWith("/20/cmdline")) return ++daemonCommandReads === 1 ? "node\0lcm\0daemon\0start" : "node\0other";
      if (path.endsWith("daemon.token")) return "token";
      throw new Error(`unexpected read ${path}`);
    });
    const fetch = vi.fn(async (url: string) => url.endsWith("/health")
      ? { ok: true, json: async () => ({ status: "ok", pid: 20 }) }
      : { ok: true, json: async () => ({}) });
    const kill = vi.fn();
    const result = await ensureDaemon({
      ...base(), _procRoot: "/proc", _uid: 1000, _skipSpawn: true, _skipHealthWait: false,
      _fetchOverride: fetch as never, _isProcessAliveOverride: () => true, _killOverride: kill,
    });
    expect(result.connected).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not signal when a wrong-parent first inspection becomes unavailable on reinspection", async () => {
    let pidReads = 0;
    fs.exists.mockImplementation((path: string) => path.endsWith("daemon.token"));
    fs.readdir.mockReturnValue([{ isDirectory: () => true, name: "11" }]);
    fs.read.mockImplementation((path: string) => {
      if (path.endsWith("daemon.pid")) {
        pidReads++;
        if (pidReads === 1) return "20";
        throw new Error("pid disappeared");
      }
      if (path.endsWith("/11/status")) return "Uid:\t1000\nPPid:\t1\n";
      if (path.endsWith("/11/cmdline")) return "systemd\0--user";
      if (path.endsWith("/20/status")) return "Uid:\t1000\nPPid:\t10\n";
      if (path.endsWith("/20/cmdline")) return "node\0lcm\0daemon\0start";
      if (path.endsWith("daemon.token")) return "token";
      throw new Error(`unexpected read ${path}`);
    });
    const fetch = vi.fn(async (url: string) => url.endsWith("/health")
      ? { ok: true, json: async () => ({ status: "ok", pid: 20 }) }
      : { ok: true, json: async () => ({}) });
    const kill = vi.fn();
    const result = await ensureDaemon({
      ...base(), _procRoot: "/proc", _uid: 1000, _skipSpawn: true, _skipHealthWait: false,
      _fetchOverride: fetch as never, _isProcessAliveOverride: () => true, _killOverride: kill,
    });
    expect(result.connected).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});
