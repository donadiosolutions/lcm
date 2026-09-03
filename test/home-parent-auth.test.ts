import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsControl = vi.hoisted(() => ({
  files: new Map<string, string>(),
  error: undefined as Error | undefined,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
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
  classifyHomeParent,
  observationFromPaths,
  parseHomeParentWitness,
  parseUidMap,
  readProcText,
  parentModeIsSafe,
  witnessContent,
} from "../src/home-parent-auth.js";

const originalPlatform = process.platform;
const originalGetuid = process.getuid;

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  process.getuid = originalGetuid;
  fsControl.files.clear();
  fsControl.error = undefined;
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

    const home = fs.mkdtempSync("/tmp/lcm-home-parent-auth-");
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
    const home = fs.mkdtempSync("/tmp/lcm-home-parent-root-");
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
    const home = fs.mkdtempSync("/tmp/lcm-home-parent-witness-");
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
