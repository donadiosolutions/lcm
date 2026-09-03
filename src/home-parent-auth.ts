import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  assertPrivateDirectory,
  openPrivateDirectory,
  readBoundedRegularFile,
} from "./security-files.js";

export const HOME_PARENT_WITNESS_VERSION = 1 as const;
export const HOME_PARENT_WITNESS_NAME = "home-parent-witness.json";
export const MAX_HOME_PARENT_WITNESS_BYTES = 8 * 1024;

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

export function classifyHomeParent(
  observation: HomeParentObservation,
  options: { rootPresent: boolean; witnessRoot: string },
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
      if (!options.rootPresent) throw new Error("overflow home parent requires a direct-root witness");
      const privateRootPath = resolve(join(options.witnessRoot, ".lcm"));
      const privateRoot = openPrivateDirectory(privateRootPath, { expectedUid: current });
      try {
        assertPrivateDirectory(privateRoot, privateRootPath, privateRoot.witness, current);
        const witness = parseHomeParentWitness(readBoundedRegularFile(witnessPath(options.witnessRoot), {
          allowedRoot: privateRootPath,
          maxBytes: MAX_HOME_PARENT_WITNESS_BYTES,
          expectedUid: current,
          allowedModes: [0o600],
          requireSingleLink: true,
        }));
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
