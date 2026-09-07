import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve, join } from "node:path";
import {
  assertPrivateDirectory,
  openPrivateDirectory,
  readBoundedRegularFile,
} from "./security-files.js";

export const HOME_PARENT_WITNESS_VERSION = 1 as const;
export const HOME_PARENT_WITNESS_NAME = "home-parent-witness.json";
export const MAX_HOME_PARENT_WITNESS_BYTES = 8 * 1024;

/** Fixed absolute path of the user-manager transient-unit launcher. */
export const HOST_VIEW_SYSTEMD_RUN = "/usr/bin/systemd-run";
export const HOST_VIEW_HELPER_VERSION = 1 as const;
export const HOST_VIEW_TIMEOUT_MS = 10_000;
export const MAX_HOST_VIEW_OUTPUT_BYTES = 4 * 1024;

/**
 * Exact observation logic executed by the user-manager host-view helper. It
 * descriptor-opens the requested canonical parent without following the leaf,
 * binds the descriptor to the pathname, returns its own uid_map for caller
 * validation, and emits one canonical JSON line. Any failure exits nonzero.
 */
export const HOST_VIEW_HELPER_SOURCE = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const target = process.argv[1];",
  "if (process.argv.length !== 2 || typeof target !== 'string' || !path.isAbsolute(target) || path.resolve(target) !== target) throw new Error('host-view target is not canonical');",
  "const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);",
  "const stat = fs.fstatSync(fd, { bigint: true });",
  "if (!stat.isDirectory()) throw new Error('host-view target is not a directory');",
  "if (fs.realpathSync(target) !== target) throw new Error('host-view target path is not canonical');",
  "const pathStat = fs.statSync(target, { bigint: true });",
  "if (pathStat.dev !== stat.dev || pathStat.ino !== stat.ino || pathStat.uid !== stat.uid || pathStat.gid !== stat.gid || (pathStat.mode & 0o7777n) !== (stat.mode & 0o7777n)) throw new Error('host-view target changed during validation');",
  "const uidMap = fs.readFileSync('/proc/self/uid_map', 'utf8');",
  "if (Buffer.byteLength(uidMap, 'utf8') > 4096) throw new Error('host-view uid_map is oversized');",
  "fs.closeSync(fd);",
  "process.stdout.write(JSON.stringify({ ctimeNs: String(stat.ctimeNs), dev: String(stat.dev), gid: Number(stat.gid), ino: String(stat.ino), mode: Number(stat.mode & 0o7777n), uid: Number(stat.uid), uidMap, version: 1 }) + '\\n');",
].join("\n");

export type ParentAuthority = "current-user" | "direct-system-root" | "witnessed-system-root";
export type UidMapRange = Readonly<{ inside: number; outside: number; length: number }>;

export type HomeParentObservation = Readonly<{
  homePath: string;
  homeDev: string;
  homeIno: string;
  homeUid: number;
  parentPath: string;
  parentDev: string;
  parentIno: string;
  parentMode: number;
  parentUid: number;
  parentGid: string;
  parentCtimeNs: string;
}>;

export type HomeParentWitnessPayload = Readonly<{
  version: typeof HOME_PARENT_WITNESS_VERSION;
  homePath: string;
  homeDev: string;
  homeIno: string;
  parentPath: string;
  parentDev: string;
  parentIno: string;
  parentMode: number;
  parentUid: 0;
  parentGid: string;
  parentCtimeNs: string;
}>;

export type HomeParentWitness = HomeParentWitnessPayload & Readonly<{ checksumSha256: string }>;

export type HostViewHelperObservation = Readonly<{
  version: typeof HOST_VIEW_HELPER_VERSION;
  uid: number;
  gid: number;
  dev: string;
  ino: string;
  mode: number;
  ctimeNs: string;
  uidMap: string;
}>;

export type HostViewSpawnResult = Readonly<{
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}>;

export type HostViewSpawnOptions = Readonly<{
  stdio: readonly ["ignore", "pipe", "pipe"];
  env: Readonly<Record<string, string>>;
  timeout: number;
  killSignal: "SIGKILL";
  maxBuffer: number;
  encoding: "utf8";
  windowsHide: true;
}>;

export type HostViewSpawnSeam = (
  command: string,
  args: readonly string[],
  options: HostViewSpawnOptions,
) => HostViewSpawnResult;

export type ClassifyHomeParentOptions = Readonly<{
  rootPresent: boolean;
  witnessRoot: string;
  /** Injected process seam for the user-manager host-view helper. */
  hostViewSpawn?: HostViewSpawnSeam;
  /** Environment consulted for the user-manager bus; defaults to process.env. */
  hostViewEnv?: Readonly<Record<string, string | undefined>>;
}>;

function canonical(value: null | boolean | number | string | { [key: string]: unknown }): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key] as never)}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function witnessPath(homeDir: string): string {
  return join(resolve(homeDir), ".lcm", HOME_PARENT_WITNESS_NAME);
}

export function witnessPayload(observation: HomeParentObservation): HomeParentWitnessPayload {
  return {
    version: HOME_PARENT_WITNESS_VERSION,
    homePath: resolve(observation.homePath),
    homeDev: observation.homeDev,
    homeIno: observation.homeIno,
    parentPath: resolve(observation.parentPath),
    parentDev: observation.parentDev,
    parentIno: observation.parentIno,
    parentMode: observation.parentMode,
    parentUid: 0,
    parentGid: observation.parentGid,
    parentCtimeNs: observation.parentCtimeNs,
  };
}

export function witnessContent(observation: HomeParentObservation): string {
  const payload = witnessPayload(observation);
  return `${canonical({ ...payload, checksumSha256: sha256(canonical(payload as unknown as { [key: string]: unknown })) })}\n`;
}

export function parseHomeParentWitness(content: string): HomeParentWitness {
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new Error("home parent witness is malformed"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("home parent witness is malformed");
  const record = value as Record<string, unknown>;
  const expected = [
    "checksumSha256", "homeDev", "homeIno", "homePath", "parentCtimeNs", "parentDev",
    "parentGid", "parentIno", "parentMode", "parentPath", "parentUid", "version",
  ];
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("home parent witness has unexpected fields");
  }
  const payload = {
    version: record.version,
    homePath: record.homePath,
    homeDev: record.homeDev,
    homeIno: record.homeIno,
    parentPath: record.parentPath,
    parentDev: record.parentDev,
    parentIno: record.parentIno,
    parentMode: record.parentMode,
    parentUid: record.parentUid,
    parentGid: record.parentGid,
    parentCtimeNs: record.parentCtimeNs,
  };
  if (payload.version !== HOME_PARENT_WITNESS_VERSION
    || typeof payload.homePath !== "string" || !payload.homePath.startsWith("/")
    || typeof payload.parentPath !== "string" || !payload.parentPath.startsWith("/")
    || typeof payload.homeDev !== "string" || !/^\d+$/u.test(payload.homeDev)
    || typeof payload.homeIno !== "string" || !/^\d+$/u.test(payload.homeIno)
    || typeof payload.parentDev !== "string" || !/^\d+$/u.test(payload.parentDev)
    || typeof payload.parentIno !== "string" || !/^\d+$/u.test(payload.parentIno)
    || typeof payload.parentGid !== "string" || !/^\d+$/u.test(payload.parentGid)
    || typeof payload.parentCtimeNs !== "string" || !/^\d+$/u.test(payload.parentCtimeNs)
    || !Number.isSafeInteger(payload.parentMode) || (payload.parentMode as number) < 0 || (payload.parentMode as number) > 0o7777
    || payload.parentUid !== 0 || typeof record.checksumSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.checksumSha256)) {
    throw new Error("home parent witness fields are invalid");
  }
  const typed = payload as unknown as HomeParentWitnessPayload;
  if (sha256(canonical(typed as unknown as { [key: string]: unknown })) !== record.checksumSha256) {
    throw new Error("home parent witness checksum does not match");
  }
  if (witnessContent({
    homePath: typed.homePath,
    homeDev: typed.homeDev,
    homeIno: typed.homeIno,
    homeUid: 0,
    parentPath: typed.parentPath,
    parentDev: typed.parentDev,
    parentIno: typed.parentIno,
    parentMode: typed.parentMode,
    parentUid: 0,
    parentGid: typed.parentGid,
    parentCtimeNs: typed.parentCtimeNs,
  }) !== content) throw new Error("home parent witness is not canonical");
  return { ...typed, checksumSha256: record.checksumSha256 };
}

export function parseUidMap(content: string): UidMapRange[] {
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error("uid_map is empty");
  const ranges: UidMapRange[] = [];
  for (const line of lines) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length !== 3 || fields.some((field) => !/^\d+$/u.test(field))) throw new Error("uid_map is malformed");
    const [insideText, outsideText, lengthText] = fields;
    const inside = Number(insideText); const outside = Number(outsideText); const length = Number(lengthText);
    if (!Number.isSafeInteger(inside) || !Number.isSafeInteger(outside) || !Number.isSafeInteger(length)
      || length <= 0 || inside + length > 0x1_0000_0000 || outside + length > 0x1_0000_0000) {
      throw new Error("uid_map range is invalid");
    }
    ranges.push({ inside, outside, length });
  }
  for (let i = 0; i < ranges.length; i += 1) for (let j = i + 1; j < ranges.length; j += 1) {
    const a = ranges[i]!; const b = ranges[j]!;
    if ((a.inside < b.inside + b.length && b.inside < a.inside + a.length)
      || (a.outside < b.outside + b.length && b.outside < a.outside + a.length)) {
      throw new Error("uid_map ranges overlap");
    }
  }
  return ranges;
}

export function hostUidForNamespaceUid(ranges: readonly UidMapRange[], uid: number): number | undefined {
  const range = ranges.find((candidate) => uid >= candidate.inside && uid < candidate.inside + candidate.length);
  return range === undefined ? undefined : range.outside + uid - range.inside;
}

export function namespaceUidForParentUid(ranges: readonly UidMapRange[], uid: number): number | undefined {
  const range = ranges.find((candidate) => uid >= candidate.outside && uid < candidate.outside + candidate.length);
  return range === undefined ? undefined : range.inside + uid - range.outside;
}

export function readProcText(path: string, label: string, maxBytes = 4 * 1024): string {
  let content: string;
  try { content = readFileSync(path, "utf8"); } catch (error) { throw new Error(`${label} is unavailable: ${String(error)}`); }
  if (Buffer.byteLength(content, "utf8") > maxBytes) throw new Error(`${label} is oversized`);
  return content;
}

function parseOverflowUid(content: string): number {
  const value = content.trim();
  if (!/^\d+$/u.test(value)) throw new Error("kernel overflow UID is malformed");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
    throw new Error("kernel overflow UID is invalid");
  }
  return parsed;
}

function defaultHostViewSpawn(command: string, args: readonly string[], options: HostViewSpawnOptions): HostViewSpawnResult {
  const result = spawnSync(command, [...args], {
    stdio: [...options.stdio],
    env: { ...options.env },
    timeout: options.timeout,
    killSignal: options.killSignal,
    maxBuffer: options.maxBuffer,
    encoding: options.encoding,
    windowsHide: options.windowsHide,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    error: result.error,
  };
}

/** Canonical single-line output the host-view helper must produce. */
export function hostViewHelperOutput(observation: HostViewHelperObservation): string {
  return `${canonical({ ...observation })}\n`;
}

function isSafeEnvironmentValue(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001F\u007F]/u.test(value);
}

function hostViewBusEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const runtimeDir = env.XDG_RUNTIME_DIR;
  if (!isSafeEnvironmentValue(runtimeDir) || !isAbsolute(runtimeDir)) {
    throw new Error("user manager bus is unavailable: XDG_RUNTIME_DIR is not a usable absolute path");
  }
  const result: Record<string, string> = { XDG_RUNTIME_DIR: runtimeDir };
  const bus = env.DBUS_SESSION_BUS_ADDRESS;
  if (isSafeEnvironmentValue(bus) && /^(?:unix|tcp|unixexec):/u.test(bus)) result.DBUS_SESSION_BUS_ADDRESS = bus;
  return result;
}

function hostViewPrivateTmpDir(witnessRoot: string, current: number): string {
  const path = resolve(witnessRoot);
  // The helper never writes, but its TMPDIR must still be the authenticated
  // owner-controlled HOME rather than a shared host temporary root.
  if (!isSafeEnvironmentValue(path) || ["/", "/tmp", "/var/tmp", "/dev/shm"].includes(path)) {
    throw new Error("host-view helper TMPDIR must be a private path outside host temporary directories");
  }
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(path); } catch (error) { throw new Error(`host-view helper TMPDIR is unavailable: ${String(error)}`); }
  if (!stat.isDirectory() || stat.uid !== current || (stat.mode & 0o022) !== 0) {
    throw new Error("host-view helper TMPDIR is not an owner-controlled private directory");
  }
  return path;
}

function parseHostViewOutput(stdout: string): HostViewHelperObservation {
  if (Buffer.byteLength(stdout, "utf8") > MAX_HOST_VIEW_OUTPUT_BYTES) throw new Error("host-view helper output is oversized");
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new Error("host-view helper output is malformed"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("host-view helper output is malformed");
  const record = value as Record<string, unknown>;
  const expected = ["ctimeNs", "dev", "gid", "ino", "mode", "uid", "uidMap", "version"];
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("host-view helper output has unexpected fields");
  }
  const isUnsignedText = (field: unknown): field is string => typeof field === "string" && /^\d+$/u.test(field);
  const isId = (field: unknown): field is number => Number.isSafeInteger(field) && (field as number) >= 0 && (field as number) <= 0xffff_ffff;
  if (record.version !== HOST_VIEW_HELPER_VERSION
    || !isId(record.uid) || !isId(record.gid)
    || !isUnsignedText(record.dev) || !isUnsignedText(record.ino) || !isUnsignedText(record.ctimeNs)
    || !isId(record.mode) || record.mode > 0o7777
    || typeof record.uidMap !== "string") {
    throw new Error("host-view helper output fields are invalid");
  }
  const observation: HostViewHelperObservation = {
    version: HOST_VIEW_HELPER_VERSION,
    uid: record.uid,
    gid: record.gid,
    dev: record.dev,
    ino: record.ino,
    mode: record.mode,
    ctimeNs: record.ctimeNs,
    uidMap: record.uidMap,
  };
  if (hostViewHelperOutput(observation) !== stdout) throw new Error("host-view helper output is not canonical");
  return observation;
}

/**
 * Ask the per-user service manager to observe the canonical home parent from
 * its own (host) view. The manager runs the helper as the same UID in its own
 * user namespace; the helper proves that namespace maps UID 0 to parent UID 0
 * before its owner observation is accepted. Overflow is never authority.
 */
export function hostViewParentObservation(
  observation: HomeParentObservation,
  options: ClassifyHomeParentOptions,
  current: number,
): HostViewHelperObservation {
  const parentPath = observation.parentPath;
  if (!isSafeEnvironmentValue(parentPath) || !isAbsolute(parentPath) || resolve(parentPath) !== parentPath) {
    throw new Error("host-view target is not canonical");
  }
  const tmpDir = hostViewPrivateTmpDir(options.witnessRoot, current);
  const env = { ...hostViewBusEnvironment(options.hostViewEnv ?? process.env), TMPDIR: tmpDir };
  const spawn = options.hostViewSpawn ?? defaultHostViewSpawn;
  const result = spawn(HOST_VIEW_SYSTEMD_RUN, [
    "--user", "--wait", "--collect", "--pipe", "--quiet",
    `--setenv=TMPDIR=${tmpDir}`,
    process.execPath, "-e", HOST_VIEW_HELPER_SOURCE, "--", parentPath,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    timeout: HOST_VIEW_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: MAX_HOST_VIEW_OUTPUT_BYTES * 4,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") throw new Error("host-view helper timed out");
    throw new Error(`host-view helper could not be started: ${result.error.message}`);
  }
  if (result.signal !== null) throw new Error(`host-view helper was terminated by signal ${result.signal}`);
  if (result.status !== 0) throw new Error(`host-view helper exited with status ${String(result.status)}`);
  if (result.stderr.length > 0) throw new Error("host-view helper wrote to stderr");
  const helper = parseHostViewOutput(result.stdout);
  const map = parseUidMap(helper.uidMap);
  if (hostUidForNamespaceUid(map, 0) !== 0) throw new Error("host-view helper is not in a direct-root user namespace");
  if (helper.uid !== 0) throw new Error("host-view home parent owner is not host root");
  if (helper.dev !== observation.parentDev || helper.ino !== observation.parentIno
    || helper.mode !== observation.parentMode || helper.ctimeNs !== observation.parentCtimeNs) {
    throw new Error("host-view home parent does not match the retained topology");
  }
  return helper;
}

function witnessIsAbsent(path: string, error: unknown): boolean {
  if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") return false;
  try { lstatSync(path); return false; } catch (probe) {
    return (probe as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export function classifyHomeParent(
  observation: HomeParentObservation,
  options: ClassifyHomeParentOptions,
): ParentAuthority {
  const current = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (process.platform === "linux" && observation.parentUid === 0) {
    const map = parseUidMap(readProcText("/proc/self/uid_map", "uid_map"));
    if (hostUidForNamespaceUid(map, 0) === 0) return "direct-system-root";
  } else if (observation.parentUid === 0) return "direct-system-root";
  if (process.platform === "linux") {
    const overflow = parseOverflowUid(readProcText("/proc/sys/kernel/overflowuid", "kernel overflow UID"));
    if (observation.parentUid === overflow) {
      if (current === undefined) throw new Error("overflow home parent cannot be authenticated without current UID");
      const map = parseUidMap(readProcText("/proc/self/uid_map", "uid_map"));
      if (namespaceUidForParentUid(map, 0) !== undefined) throw new Error("overflow home parent is not trusted in a root-mapped namespace");
      if (!options.rootPresent) {
        // No private root exists, so no witness can exist. Independent
        // host-view evidence is the only remaining direct-root authority.
        return hostViewDirectRoot(observation, options, current);
      }
      const privateRootPath = resolve(join(options.witnessRoot, ".lcm"));
      const privateRoot = openPrivateDirectory(privateRootPath, { expectedUid: current });
      try {
        assertPrivateDirectory(privateRoot, privateRootPath, privateRoot.witness, current);
        const path = witnessPath(options.witnessRoot);
        let content: string;
        try {
          content = readBoundedRegularFile(path, {
            allowedRoot: privateRootPath,
            maxBytes: MAX_HOME_PARENT_WITNESS_BYTES,
            expectedUid: current,
            allowedModes: [0o600],
            requireSingleLink: true,
          });
        } catch (error) {
          // Only a genuinely absent witness may consult the host view. Any
          // existing but unreadable, unsafe, or malformed witness keeps its
          // existing fail-closed error.
          if (!witnessIsAbsent(path, error)) throw error;
          assertPrivateDirectory(privateRoot, privateRootPath, privateRoot.witness, current);
          return hostViewDirectRoot(observation, options, current);
        }
        const witness = parseHomeParentWitness(content);
        assertPrivateDirectory(privateRoot, privateRootPath, privateRoot.witness, current);
        const expected = witnessPayload(observation);
        for (const key of ["homePath", "homeDev", "homeIno", "parentPath", "parentDev", "parentIno", "parentMode", "parentUid", "parentCtimeNs"] as const) {
          if (witness[key] !== expected[key]) throw new Error("home parent witness is stale or does not match the live topology");
        }
        return "witnessed-system-root";
      } finally {
        privateRoot.close();
      }
    }
  }
  if (current === undefined) return "current-user";
  if (observation.parentUid === current) return "current-user";
  throw new Error("home parent owner is not trusted");
}

function hostViewDirectRoot(
  observation: HomeParentObservation,
  options: ClassifyHomeParentOptions,
  current: number,
): ParentAuthority {
  try {
    hostViewParentObservation(observation, options, current);
  } catch (error) {
    throw new Error(`overflow home parent requires a direct-root witness: ${(error as Error).message}`);
  }
  return "direct-system-root";
}

export function parentModeIsSafe(mode: number, authority: ParentAuthority): boolean {
  return (mode & 0o022) === 0 || ((mode & 0o1000) !== 0
    && (authority === "current-user" || authority === "direct-system-root" || authority === "witnessed-system-root"));
}

export function observationFromPaths(input: {
  homePath: string; homeDev: string; homeIno: string; homeUid: number;
  parentPath: string; parentDev: string; parentIno: string; parentMode: number;
  parentUid: number; parentGid: string; parentCtimeNs: string;
}): HomeParentObservation {
  return input;
}
