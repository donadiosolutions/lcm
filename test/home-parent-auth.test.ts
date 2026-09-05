import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsControl = vi.hoisted(() => ({
  files: new Map<string, string>(),
  error: undefined as Error | undefined,
  openError: undefined as Error | undefined,
  lstatError: undefined as Error | undefined,
}));

const spawnControl = vi.hoisted(() => ({
  result: undefined as Partial<SpawnSyncReturns<string>> | undefined,
  calls: [] as Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }>,
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: (command: string, args: readonly string[], options: Record<string, unknown>) => {
      if (spawnControl.result !== undefined && command === "/usr/bin/systemd-run") {
        spawnControl.calls.push({ command, args, options });
        return spawnControl.result as SpawnSyncReturns<string>;
      }
      return (actual.spawnSync as (...a: unknown[]) => unknown)(command, args, options);
    },
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    openSync: (path: fs.PathLike, ...rest: unknown[]) => {
      if (fsControl.openError !== undefined && String(path).endsWith("home-parent-witness.json")) throw fsControl.openError;
      return (actual.openSync as (...args: unknown[]) => number)(path, ...rest);
    },
    lstatSync: (path: fs.PathLike, ...rest: unknown[]) => {
      if (fsControl.lstatError !== undefined && String(path).endsWith("home-parent-witness.json")) throw fsControl.lstatError;
      return (actual.lstatSync as (...args: unknown[]) => fs.Stats)(path, ...rest);
    },
    readFileSync: (path: fs.PathLike, options?: unknown) => {
      if (fsControl.error !== undefined) throw fsControl.error;
      const replacement = fsControl.files.get(String(path));
      if (replacement !== undefined) return replacement as never;
      return actual.readFileSync(path, options as never);
    },
  };
});
import {
  hostUidForNamespaceUid,
  namespaceUidForParentUid,
  classifyHomeParent,
  observationFromPaths,
  parseHomeParentWitness,
  parseUidMap,
  readProcText,
  parentModeIsSafe,
  witnessContent,
  hostViewHelperOutput,
  hostViewParentObservation,
  HOST_VIEW_HELPER_SOURCE,
  type HostViewSpawnOptions,
  type HostViewSpawnResult,
  type HostViewSpawnSeam,
} from "../src/home-parent-auth.js";

const originalPlatform = process.platform;
const originalGetuid = process.getuid;

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  process.getuid = originalGetuid;
  fsControl.files.clear();
  fsControl.error = undefined;
  fsControl.openError = undefined;
  fsControl.lstatError = undefined;
  spawnControl.result = undefined;
  spawnControl.calls = [];
  vi.restoreAllMocks();
});

function observation(parentUid = 1234) {
  return observationFromPaths({
    homePath: "/home/user", homeDev: "1", homeIno: "2", homeUid: 1000,
    parentPath: "/home", parentDev: "3", parentIno: "4", parentMode: 0o755,
    parentUid, parentGid: "0", parentCtimeNs: "5",
  });
}

function procFiles(files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) fsControl.files.set(path, content);
}

describe("home parent authentication", () => {
  it("parses disjoint uid-map ranges and resolves mapped identities", () => {
    const ranges = parseUidMap("0 1000 1\n1000 2000 10\n");
    expect(hostUidForNamespaceUid(ranges, 0)).toBe(1000);
    expect(hostUidForNamespaceUid(ranges, 1005)).toBe(2005);
    expect(hostUidForNamespaceUid(ranges, 99)).toBeUndefined();
    expect(namespaceUidForParentUid(ranges, 1000)).toBe(0);
    expect(namespaceUidForParentUid(ranges, 2005)).toBe(1005);
    expect(namespaceUidForParentUid(ranges, 99)).toBeUndefined();
  });

  it.each(["", "0 0 0\n", "0 0 1\n0 2 1\n", "bad map\n"])(
    "rejects malformed uid-map content: %s",
    (content) => {
      expect(() => parseUidMap(content)).toThrow();
    },
  );

  it("covers uid-map boundary values, outside overlaps, and lookup edges", () => {
    const ranges = parseUidMap("4294967295 4294967295 1\n2 100 2\n");
    expect(hostUidForNamespaceUid(ranges, 4294967295)).toBe(4294967295);
    expect(hostUidForNamespaceUid(ranges, 4)).toBeUndefined();
    expect(() => parseUidMap("0 100 2\n2 101 1\n")).toThrow("overlap");
  });

  it("round-trips a canonical checksummed witness", () => {
    const observation = {
      homePath: "/home/user",
      homeDev: "10",
      homeIno: "11",
      homeUid: 1000,
      parentPath: "/home",
      parentDev: "12",
      parentIno: "13",
      parentMode: 0o755,
      parentUid: 0,
      parentGid: "0",
      parentCtimeNs: "14",
    };
    const content = witnessContent(observation);
    expect(parseHomeParentWitness(content)).toMatchObject({
      homePath: "/home/user",
      parentUid: 0,
      parentCtimeNs: "14",
    });
    expect(() => parseHomeParentWitness(content.replace("parentCtimeNs", "parentCtime"))).toThrow();
    expect(() => parseHomeParentWitness(content.replace(/"checksumSha256":"[0-9a-f]+"/u, `"checksumSha256":"${"0".repeat(64)}"`))).toThrow("checksum");
    expect(() => parseHomeParentWitness(content.trimEnd())).toThrow("canonical");
  });

  it("rejects malformed, non-object, and invalid-field witnesses", () => {
    expect(() => parseHomeParentWitness("not json")).toThrow("malformed");
    expect(() => parseHomeParentWitness("[]")).toThrow("malformed");
    const valid = JSON.parse(witnessContent(observation(0))) as Record<string, unknown>;
    valid.parentMode = 0o10000;
    expect(() => parseHomeParentWitness(JSON.stringify(valid))).toThrow("fields are invalid");
  });

  it("rejects out-of-range uid-map values and foreign parent owners", () => {
    expect(() => parseUidMap("0 0 4294967297\n")).toThrow("range");
    expect(() => classifyHomeParent(observationFromPaths({
      homePath: "/home/user", homeDev: "1", homeIno: "2", homeUid: 1000,
      parentPath: "/home", parentDev: "3", parentIno: "4", parentMode: 0o755,
      parentUid: 1234, parentGid: "0", parentCtimeNs: "5",
    }), { rootPresent: false, witnessRoot: "/home/user" })).toThrow("owner");
  });

  it("reports unavailable and oversized proc files", () => {
    fsControl.error = new Error("permission denied");
    expect(() => readProcText("/proc/self/uid_map", "uid_map")).toThrow("unavailable");
    fsControl.error = undefined;
    procFiles({ "/proc/self/uid_map": "x".repeat(5) });
    expect(() => readProcText("/proc/self/uid_map", "uid_map", 4)).toThrow("oversized");
  });

  it("authenticates direct root in root-mapped and non-Linux environments", () => {
    procFiles({ "/proc/self/uid_map": "0 0 1\n" });
    expect(classifyHomeParent(observation(0), { rootPresent: false, witnessRoot: "/home/user" }))
      .toBe("direct-system-root");
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    expect(classifyHomeParent(observation(0), { rootPresent: false, witnessRoot: "/home/user" }))
      .toBe("direct-system-root");
  });

  it("does not treat a namespace-mapped UID zero as host root", () => {
    procFiles({
      "/proc/self/uid_map": "0 1000 1\n",
      "/proc/sys/kernel/overflowuid": "65534\n",
    });
    expect(() => classifyHomeParent(observation(0), { rootPresent: false, witnessRoot: "/home/user" }))
      .toThrow("owner");
  });

  it("does not treat namespace UID zero mapped to the current user as host-root mapping", () => {
    const home = fs.mkdtempSync(join(tmpdir(), "lcm-home-parent-current-root-"));
    expect(dirname(home)).toBe(tmpdir());
    const root = join(home, ".lcm");
    fs.mkdirSync(root, { mode: 0o700 });
    const live = observationFromPaths({
      ...observation(65534),
      homePath: home,
      parentPath: dirname(home),
    });
    fs.writeFileSync(join(root, "home-parent-witness.json"), witnessContent(live), { mode: 0o600 });
    procFiles({
      "/proc/self/uid_map": "0 1000 1\n",
      "/proc/sys/kernel/overflowuid": "65534\n",
    });
    try {
      expect(classifyHomeParent(live, { rootPresent: true, witnessRoot: home }))
        .toBe("witnessed-system-root");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("exercises the non-Linux parent-owner branch directly", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    expect(classifyHomeParent(observation(0), { rootPresent: false, witnessRoot: "/home/user" }))
      .toBe("direct-system-root");
  });

  it("falls back to current-user authority when getuid is unavailable", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    process.getuid = undefined;
    expect(classifyHomeParent(observation(1234), { rootPresent: false, witnessRoot: "/home/user" }))
      .toBe("current-user");
    process.getuid = () => 1234;
    expect(classifyHomeParent(observation(1234), { rootPresent: false, witnessRoot: "/home/user" }))
      .toBe("current-user");
  });

  it("requires a witness for overflow ownership and fails closed at each boundary", () => {
    procFiles({
      "/proc/sys/kernel/overflowuid": "not-a-number\n",
      "/proc/self/uid_map": "1000 1000 1\n",
    });
    expect(() => classifyHomeParent(observation(65534), { rootPresent: false, witnessRoot: "/home/user" }))
      .toThrow("malformed");

    procFiles({
      "/proc/sys/kernel/overflowuid": "4294967296\n",
      "/proc/self/uid_map": "1000 1000 1\n",
    });
    expect(() => classifyHomeParent(observation(65534), { rootPresent: false, witnessRoot: "/home/user" }))
      .toThrow("invalid");

    procFiles({
      "/proc/sys/kernel/overflowuid": "65534\n",
      "/proc/self/uid_map": "0 0 1\n",
    });
    expect(() => classifyHomeParent(observation(65534), { rootPresent: true, witnessRoot: "/home/user" }))
      .toThrow("root-mapped");

    procFiles({
      "/proc/sys/kernel/overflowuid": "65534\n",
      "/proc/self/uid_map": "1000 1000 1\n",
    });
    expect(() => classifyHomeParent(observation(65534), { rootPresent: false, witnessRoot: "/home/user" }))
      .toThrow("requires a direct-root witness");
  });

  it("rejects overflow ownership without getuid and with a stale witness", () => {
    procFiles({
      "/proc/sys/kernel/overflowuid": "65534\n",
      "/proc/self/uid_map": "1000 1000 1\n",
    });
    process.getuid = undefined;
    expect(() => classifyHomeParent(observation(65534), { rootPresent: true, witnessRoot: "/home/user" }))
      .toThrow("without current UID");

    const home = fs.mkdtempSync(join(tmpdir(), "lcm-home-parent-auth-"));
    expect(dirname(home)).toBe(tmpdir());
    const root = join(home, ".lcm");
    fs.mkdirSync(root, { mode: 0o700 });
    const live = observationFromPaths({ ...observation(65534), homePath: home, parentPath: dirname(home) });
    fs.writeFileSync(join(root, "home-parent-witness.json"), witnessContent({ ...live, homeIno: "999" }), { mode: 0o600 });
    process.getuid = originalGetuid;
    expect(() => classifyHomeParent(live, { rootPresent: true, witnessRoot: home })).toThrow("stale");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("fails closed for unsafe, symlinked, and replaced private roots", () => {
    procFiles({
      "/proc/sys/kernel/overflowuid": "65534\n",
      "/proc/self/uid_map": "1000 1000 1\n",
    });
    const home = fs.mkdtempSync(join(tmpdir(), "lcm-home-parent-root-"));
    expect(dirname(home)).toBe(tmpdir());
    const root = join(home, ".lcm");
    fs.mkdirSync(root, { mode: 0o755 });
    expect(() => classifyHomeParent(observation(65534), { rootPresent: true, witnessRoot: home }))
      .toThrow("private directory mode");

    fs.rmSync(root, { recursive: true, force: true });
    const replacement = join(home, "replacement");
    fs.mkdirSync(replacement, { mode: 0o700 });
    fs.symlinkSync(replacement, root, "dir");
    expect(() => classifyHomeParent(observation(65534), { rootPresent: true, witnessRoot: home }))
      .toThrow();

    fs.rmSync(root, { force: true });
    fs.mkdirSync(root, { mode: 0o700 });
    fs.renameSync(root, join(home, ".lcm-replaced"));
    fs.symlinkSync(replacement, root, "dir");
    expect(() => classifyHomeParent(observation(65534), { rootPresent: true, witnessRoot: home }))
      .toThrow();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("accepts an authenticated overflow-owned parent witness", () => {
    procFiles({
      "/proc/sys/kernel/overflowuid": "65534\n",
      "/proc/self/uid_map": "1000 1000 1\n",
    });
    const home = fs.mkdtempSync(join(tmpdir(), "lcm-home-parent-witness-"));
    expect(dirname(home)).toBe(tmpdir());
    const root = join(home, ".lcm");
    fs.mkdirSync(root, { mode: 0o700 });
    const homeStat = fs.statSync(home, { bigint: true });
    const parentStat = fs.statSync(dirname(home), { bigint: true });
    const live = observationFromPaths({
      homePath: home,
      homeDev: String(homeStat.dev),
      homeIno: String(homeStat.ino),
      homeUid: Number(homeStat.uid),
      parentPath: dirname(home),
      parentDev: String(parentStat.dev),
      parentIno: String(parentStat.ino),
      parentMode: Number(parentStat.mode & 0o7777n),
      parentUid: 65534,
      parentGid: String(parentStat.gid),
      parentCtimeNs: String(parentStat.ctimeNs),
    });
    fs.writeFileSync(join(root, "home-parent-witness.json"), witnessContent(live), { mode: 0o600 });
    expect(classifyHomeParent(live, { rootPresent: true, witnessRoot: home })).toBe("witnessed-system-root");
    fs.writeFileSync(join(root, "home-parent-witness.json"), witnessContent({
      ...live,
      parentCtimeNs: String(BigInt(live.parentCtimeNs) + 1n),
    }), { mode: 0o600 });
    expect(() => classifyHomeParent(live, { rootPresent: true, witnessRoot: home }))
      .toThrow("stale");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("accepts only a root-authorized sticky writable parent", () => {
    expect(parentModeIsSafe(0o1777, "direct-system-root")).toBe(true);
    expect(parentModeIsSafe(0o1777, "witnessed-system-root")).toBe(true);
    expect(parentModeIsSafe(0o1777, "current-user")).toBe(true);
    expect(parentModeIsSafe(0o777, "direct-system-root")).toBe(false);
  });
});

describe("user-manager host-view fallback for an absent witness", () => {
  const overflowProc = {
    "/proc/sys/kernel/overflowuid": "65534\n",
    "/proc/self/uid_map": "1000 1000 1\n",
  };

  function liveHome(): { home: string; live: ReturnType<typeof observationFromPaths>; parentGid: string } {
    const home = fs.mkdtempSync(join(tmpdir(), "lcm-home-parent-hostview-"));
    expect(dirname(home)).toBe(tmpdir());
    fs.mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    const homeStat = fs.statSync(home, { bigint: true });
    const parentStat = fs.statSync(dirname(home), { bigint: true });
    const live = observationFromPaths({
      homePath: home,
      homeDev: String(homeStat.dev),
      homeIno: String(homeStat.ino),
      homeUid: Number(homeStat.uid),
      parentPath: dirname(home),
      parentDev: String(parentStat.dev),
      parentIno: String(parentStat.ino),
      parentMode: Number(parentStat.mode & 0o7777n),
      parentUid: 65534,
      parentGid: String(parentStat.gid),
      parentCtimeNs: String(parentStat.ctimeNs),
    });
    return { home, live, parentGid: String(parentStat.gid) };
  }

  function helperLine(live: ReturnType<typeof observationFromPaths>, overrides: Record<string, unknown> = {}): string {
    return hostViewHelperOutput({
      version: 1,
      uid: 0,
      gid: Number(live.parentGid),
      dev: live.parentDev,
      ino: live.parentIno,
      mode: live.parentMode,
      ctimeNs: live.parentCtimeNs,
      uidMap: "         0          0 4294967295\n",
      ...overrides,
    } as never);
  }

  function ok(stdout: string, extra: Partial<HostViewSpawnResult> = {}): HostViewSpawnResult {
    return { status: 0, signal: null, stdout, stderr: "", error: undefined, ...extra };
  }

  it("classifies direct-system-root from independent host-view evidence when no witness exists", () => {
    procFiles(overflowProc);
    const { home, live } = liveHome();
    const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    const spawn: HostViewSpawnSeam = (command, args, options) => {
      calls.push({ command, args, options: options as Record<string, unknown> });
      return ok(helperLine(live));
    };
    try {
      expect(classifyHomeParent(live, { rootPresent: true, witnessRoot: home, hostViewSpawn: spawn }))
        .toBe("direct-system-root");
      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.command).toBe("/usr/bin/systemd-run");
      expect(call.args.slice(0, 5)).toEqual(["--user", "--wait", "--collect", "--pipe", "--quiet"]);
      expect(call.args.some((arg) => /^--property=/u.test(arg))).toBe(false);
      expect(call.args).not.toContain("--system");
      expect(call.args).not.toContain("--scope");
      expect(call.args).toContain(`--setenv=TMPDIR=${home}`);
      expect(call.args.at(-1)).toBe(dirname(home));
      expect(call.args.at(-2)).toBe("--");
      expect(call.args).toContain(process.execPath);
      expect(call.options.shell).toBeUndefined();
      expect(call.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
      expect(call.options.timeout).toBeGreaterThan(0);
      expect(call.options.maxBuffer).toBeGreaterThan(0);
      const env = call.options.env as Record<string, string>;
      expect(Object.keys(env).sort()).toEqual(
        Object.keys(env).filter((k) => ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "PATH", "TMPDIR", "HOME"].includes(k)).sort(),
      );
      expect(env.TMPDIR).toBe(home);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("consults the host view when no private root exists yet", () => {
    procFiles(overflowProc);
    const { home, live } = liveHome();
    fs.rmSync(join(home, ".lcm"), { recursive: true });
    try {
      expect(classifyHomeParent(live, { rootPresent: false, witnessRoot: home, hostViewSpawn: () => ok(helperLine(live)) }))
        .toBe("direct-system-root");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("never consults the host view when a witness exists but is invalid", () => {
    procFiles(overflowProc);
    const { home, live } = liveHome();
    const witnessFile = join(home, ".lcm", "home-parent-witness.json");
    let spawned = 0;
    const spawn: HostViewSpawnSeam = () => { spawned += 1; return ok(helperLine(live)); };
    try {
      fs.writeFileSync(witnessFile, "not json\n", { mode: 0o600 });
      expect(() => classifyHomeParent(live, { rootPresent: true, witnessRoot: home, hostViewSpawn: spawn })).toThrow("malformed");
      fs.writeFileSync(witnessFile, witnessContent({ ...live, homeIno: "999" }), { mode: 0o600 });
      expect(() => classifyHomeParent(live, { rootPresent: true, witnessRoot: home, hostViewSpawn: spawn })).toThrow("stale");
      fs.chmodSync(witnessFile, 0o644);
      expect(() => classifyHomeParent(live, { rootPresent: true, witnessRoot: home, hostViewSpawn: spawn })).toThrow();
      fs.rmSync(witnessFile);
      fs.symlinkSync("/nonexistent-lcm-target", witnessFile);
      expect(() => classifyHomeParent(live, { rootPresent: true, witnessRoot: home, hostViewSpawn: spawn })).toThrow();
      fs.rmSync(witnessFile);
      fs.mkdirSync(witnessFile);
      expect(() => classifyHomeParent(live, { rootPresent: true, witnessRoot: home, hostViewSpawn: spawn })).toThrow();
      expect(spawned).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("treats a witness read ENOENT as absence only when the path is really missing", () => {
    procFiles(overflowProc);
    const { home, live } = liveHome();
    let spawned = 0;
    const spawn: HostViewSpawnSeam = () => { spawned += 1; return ok(helperLine(live)); };
    try {
      // A real witness exists but the read path reports ENOENT (racy
      // replacement); the present path must keep the original error.
      fs.writeFileSync(join(home, ".lcm", "home-parent-witness.json"), witnessContent(live), { mode: 0o600 });
      fsControl.openError = Object.assign(new Error("ENOENT: simulated race"), { code: "ENOENT" });
      expect(() => classifyHomeParent(live, { rootPresent: true, witnessRoot: home, hostViewSpawn: spawn })).toThrow("simulated race");
      // An lstat failure other than ENOENT is likewise not absence.
      fs.rmSync(join(home, ".lcm", "home-parent-witness.json"));
      fsControl.lstatError = Object.assign(new Error("EACCES: simulated"), { code: "EACCES" });
      expect(() => classifyHomeParent(live, { rootPresent: true, witnessRoot: home, hostViewSpawn: spawn })).toThrow("simulated race");
      fsControl.lstatError = undefined;
      expect(spawned).toBe(0);
      // Genuinely absent: the host view is consulted.
      expect(classifyHomeParent(live, { rootPresent: true, witnessRoot: home, hostViewSpawn: spawn })).toBe("direct-system-root");
      expect(spawned).toBe(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each<[string, (live: ReturnType<typeof observationFromPaths>) => HostViewSpawnResult, string]>([
    ["spawn error", () => ({ status: null, signal: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) }), "could not be started"],
    ["timeout", () => ({ status: null, signal: "SIGKILL", stdout: "", stderr: "", error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) }), "timed out"],
    ["signal", () => ({ status: null, signal: "SIGKILL", stdout: "", stderr: "" }), "signal SIGKILL"],
    ["nonzero status", (live) => ok(helperLine(live), { status: 1 }), "status 1"],
    ["null status", () => ({ status: null, signal: null, stdout: "", stderr: "" }), "status null"],
    ["stderr", (live) => ok(helperLine(live), { stderr: "warning\n" }), "stderr"],
    ["empty stdout", () => ok(""), "malformed"],
    ["non-object stdout", () => ok("[]\n"), "malformed"],
    ["oversized stdout", () => ok(`{"a":"${"x".repeat(5000)}"}\n`), "oversized"],
    ["unexpected fields", (live) => ok(helperLine(live).replace('"version":1', '"version":1,"extra":1')), "unexpected fields"],
    ["missing field", (live) => ok(helperLine(live).replace(/"uidMap":"[^"]*",/u, "")), "unexpected fields"],
    ["wrong version", (live) => ok(helperLine(live, { version: 2 })), "fields are invalid"],
    ["negative uid", (live) => ok(helperLine(live, { uid: -1 })), "fields are invalid"],
    ["oversized gid", (live) => ok(helperLine(live, { gid: 0x1_0000_0000 })), "fields are invalid"],
    ["non-numeric dev", (live) => ok(helperLine(live, { dev: "abc" })), "fields are invalid"],
    ["non-numeric ino", (live) => ok(helperLine(live, { ino: "" })), "fields are invalid"],
    ["mode too large", (live) => ok(helperLine(live, { mode: 0o10000 })), "fields are invalid"],
    ["ctime non-numeric", (live) => ok(helperLine(live, { ctimeNs: "1.5" })), "fields are invalid"],
    ["uidMap non-string", (live) => ok(helperLine(live, { uidMap: 1 })), "fields are invalid"],
    ["noncanonical bytes", (live) => ok(`${helperLine(live).trimEnd()}`), "not canonical"],
    ["noncanonical key order", (live) => ok(`${JSON.stringify(JSON.parse(helperLine(live)))}\n`.replace('{"ctimeNs"', '{"version":1,"ctimeNs"').replace(',"version":1}', "}")), "not canonical"],
    ["helper map malformed", (live) => ok(helperLine(live, { uidMap: "bad\n" })), "uid_map is malformed"],
    ["helper not direct root", (live) => ok(helperLine(live, { uidMap: "1000 1000 1\n" })), "not in a direct-root user namespace"],
    ["helper mapped root", (live) => ok(helperLine(live, { uidMap: "0 1000 1\n" })), "not in a direct-root user namespace"],
    ["owner not root", (live) => ok(helperLine(live, { uid: 1000 })), "not host root"],
    ["owner overflow", (live) => ok(helperLine(live, { uid: 65534 })), "not host root"],
    ["dev mismatch", (live) => ok(helperLine(live, { dev: String(BigInt(live.parentDev) + 1n) })), "does not match"],
    ["ino mismatch", (live) => ok(helperLine(live, { ino: String(BigInt(live.parentIno) + 1n) })), "does not match"],
    ["mode mismatch", (live) => ok(helperLine(live, { mode: live.parentMode ^ 0o1000 })), "does not match"],
    ["ctime mismatch", (live) => ok(helperLine(live, { ctimeNs: String(BigInt(live.parentCtimeNs) + 1n) })), "does not match"],
  ])("fails closed on host-view %s", (_label, produce, message) => {
    procFiles(overflowProc);
    const { home, live } = liveHome();
    try {
      expect(() => classifyHomeParent(live, { rootPresent: true, witnessRoot: home, hostViewSpawn: () => produce(live) }))
        .toThrow(message);
      expect(() => classifyHomeParent(live, { rootPresent: true, witnessRoot: home, hostViewSpawn: () => produce(live) }))
        .toThrow("requires a direct-root witness");
      expect(fs.existsSync(join(home, ".lcm", "home-parent-witness.json"))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails closed without a usable user-manager bus environment", () => {
    procFiles(overflowProc);
    const { home, live } = liveHome();
    let spawned = 0;
    const spawn: HostViewSpawnSeam = () => { spawned += 1; return ok(helperLine(live)); };
    try {
      expect(() => classifyHomeParent(live, { rootPresent: true, witnessRoot: home, hostViewSpawn: spawn, hostViewEnv: {} }))
        .toThrow("XDG_RUNTIME_DIR");
      expect(() => classifyHomeParent(live, { rootPresent: true, witnessRoot: home, hostViewSpawn: spawn, hostViewEnv: { XDG_RUNTIME_DIR: "relative/run" } }))
        .toThrow("XDG_RUNTIME_DIR");
      expect(() => classifyHomeParent(live, { rootPresent: true, witnessRoot: home, hostViewSpawn: spawn, hostViewEnv: { XDG_RUNTIME_DIR: "/run/user/1000\n" } }))
        .toThrow("XDG_RUNTIME_DIR");
      expect(spawned).toBe(0);
      const calls: HostViewSpawnOptions[] = [];
      const recording: HostViewSpawnSeam = (_command, _args, options) => { calls.push(options); return ok(helperLine(live)); };
      expect(classifyHomeParent(live, {
        rootPresent: true, witnessRoot: home, hostViewSpawn: recording,
        hostViewEnv: { XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", PATH: "/evil", HOME: "/evil", LD_PRELOAD: "/evil.so" },
      })).toBe("direct-system-root");
      expect(calls[0]!.env).toEqual({ XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", TMPDIR: home });
      expect(classifyHomeParent(live, {
        rootPresent: true, witnessRoot: home, hostViewSpawn: recording,
        hostViewEnv: { XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "evil:path" },
      })).toBe("direct-system-root");
      expect(calls[1]!.env).toEqual({ XDG_RUNTIME_DIR: "/run/user/1000", TMPDIR: home });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses unsafe helper TMPDIR candidates", () => {
    procFiles(overflowProc);
    const { home, live } = liveHome();
    let spawned = 0;
    const spawn: HostViewSpawnSeam = () => { spawned += 1; return ok(helperLine(live)); };
    try {
      expect(() => hostViewParentObservation(live, { rootPresent: true, witnessRoot: "/tmp", hostViewSpawn: spawn }, 1000))
        .toThrow("outside host temporary directories");
      expect(() => hostViewParentObservation(live, { rootPresent: true, witnessRoot: join(home, "missing"), hostViewSpawn: spawn }, 1000))
        .toThrow("TMPDIR is unavailable");
      fs.chmodSync(home, 0o777);
      expect(() => hostViewParentObservation(live, { rootPresent: true, witnessRoot: home, hostViewSpawn: spawn }, process.getuid!() ))
        .toThrow("owner-controlled private directory");
      fs.chmodSync(home, 0o700);
      expect(() => hostViewParentObservation(live, { rootPresent: true, witnessRoot: home, hostViewSpawn: spawn }, process.getuid!() + 1))
        .toThrow("owner-controlled private directory");
      expect(() => hostViewParentObservation({ ...live, parentPath: "relative" }, { rootPresent: true, witnessRoot: home, hostViewSpawn: spawn }, process.getuid!()))
        .toThrow("not canonical");
      expect(spawned).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("runs the real fixed helper source against a live directory", () => {
    const home = fs.mkdtempSync(join(tmpdir(), "lcm-home-parent-helper-src-"));
    expect(dirname(home)).toBe(tmpdir());
    try {
      // Observe a quiescent directory this test owns so concurrent workers
      // creating siblings under the shared temporary root cannot move ctime.
      const parent = join(home, "parent");
      fs.mkdirSync(parent, { mode: 0o755 });
      const run = (target: string) => spawnSync(process.execPath, ["-e", HOST_VIEW_HELPER_SOURCE, "--", target], { encoding: "utf8" });
      const good = run(parent);
      expect(good.status).toBe(0);
      expect(good.stderr).toBe("");
      const parsed = JSON.parse(good.stdout) as Record<string, unknown>;
      const stat = fs.statSync(parent, { bigint: true });
      expect(parsed).toEqual({
        ctimeNs: String(stat.ctimeNs), dev: String(stat.dev), gid: Number(stat.gid), ino: String(stat.ino),
        mode: Number(stat.mode & 0o7777n), uid: Number(stat.uid), uidMap: fs.readFileSync("/proc/self/uid_map", "utf8"), version: 1,
      });
      expect(hostViewHelperOutput(parsed as never)).toBe(good.stdout);
      const link = join(home, "link");
      fs.symlinkSync(parent, link);
      expect(run(link).status).not.toBe(0);
      expect(run(`${parent}/`).status).not.toBe(0);
      expect(run("relative").status).not.toBe(0);
      expect(run(join(home, "missing")).status).not.toBe(0);
      const file = join(home, "file");
      fs.writeFileSync(file, "x");
      expect(run(file).status).not.toBe(0);
      expect(spawnSync(process.execPath, ["-e", HOST_VIEW_HELPER_SOURCE, "--", parent, "extra"], { encoding: "utf8" }).status).not.toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses the fixed launcher through the real spawn seam when none is injected", () => {
    procFiles(overflowProc);
    const { home, live } = liveHome();
    try {
      spawnControl.result = { status: null, signal: null, stdout: null as never, stderr: null as never, error: new Error("spawn EACCES") };
      expect(() => classifyHomeParent(live, { rootPresent: true, witnessRoot: home, hostViewEnv: { XDG_RUNTIME_DIR: "/run/user/1000" } }))
        .toThrow("could not be started: spawn EACCES");
      expect(spawnControl.calls).toHaveLength(1);
      const call = spawnControl.calls[0]!;
      expect(call.args.slice(0, 5)).toEqual(["--user", "--wait", "--collect", "--pipe", "--quiet"]);
      expect(call.args.at(-1)).toBe(dirname(home));
      expect(call.options).toMatchObject({
        stdio: ["ignore", "pipe", "pipe"], killSignal: "SIGKILL", encoding: "utf8", windowsHide: true,
        env: { XDG_RUNTIME_DIR: "/run/user/1000", TMPDIR: home },
      });
      expect(call.options.shell).toBeUndefined();
      spawnControl.result = { status: 0, signal: null, stdout: helperLine(live), stderr: "", error: undefined };
      expect(classifyHomeParent(live, { rootPresent: true, witnessRoot: home, hostViewEnv: { XDG_RUNTIME_DIR: "/run/user/1000" } }))
        .toBe("direct-system-root");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
