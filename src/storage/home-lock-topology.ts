import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

type HomeLockDirectoryStat = Readonly<{
  mode: bigint;
  uid: bigint;
  dev: bigint;
  ino: bigint;
}>;

/** A sanitized validation refusal raised by retained HOME topology checks. */
export class HomeLockTopologyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomeLockTopologyError";
  }
}

function topologyError(message: string): never {
  throw new HomeLockTopologyError(message);
}

/** Retained descriptor evidence for one HOME-level mutation lock. */
export type HomeLockTopology = Readonly<{
  homePath: string;
  parentPath: string;
  homeFd: number;
  parentFd: number;
  homeMode: number;
  homeDev: bigint;
  homeIno: bigint;
  parentDev: bigint;
  parentIno: bigint;
  expectedUid: number | undefined;
}>;

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function directoryStat(fd: number): HomeLockDirectoryStat {
  return fstatSync(fd, { bigint: true }) as unknown as HomeLockDirectoryStat;
}

function assertDirectoryIdentity(
  stat: HomeLockDirectoryStat,
  path: string,
  label: string,
): void {
  const requested = resolve(path);
  const canonical = resolve(realpathSync(path));
  if (canonical !== requested) return topologyError(`${label} path is not canonical`);
  const pathStat = statSync(canonical, { bigint: true }) as unknown as HomeLockDirectoryStat;
  if (pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
    return topologyError(`${label} changed during validation`);
  }
}

function assertTopologySecurity(
  parent: HomeLockDirectoryStat,
  home: HomeLockDirectoryStat,
  expectedUid: number | undefined,
): void {
  const parentUid = Number(parent.uid);
  const homeUid = Number(home.uid);
  const parentMode = Number(parent.mode & 0o7777n);
  const homeMode = Number(home.mode & 0o7777n);
  if (
    (expectedUid !== undefined && homeUid !== expectedUid)
    || (expectedUid !== undefined && parentUid !== expectedUid && parentUid !== 0)
    || ((homeMode & 0o022) !== 0 && (parentMode & 0o077) !== 0)
    || ((parentMode & 0o022) !== 0 && !(parentUid === 0 && (parentMode & 0o1000) !== 0))
  ) {
    return topologyError("HOME lock parent is not trusted");
  }
}

/** Revalidate the retained HOME and parent descriptors against their paths. */
export function assertHomeLockTopology(topology: HomeLockTopology): void {
  const parent = directoryStat(topology.parentFd);
  const home = directoryStat(topology.homeFd);
  assertDirectoryIdentity(parent, topology.parentPath, "HOME lock grandparent");
  assertDirectoryIdentity(home, topology.homePath, "HOME lock parent");
  assertTopologySecurity(parent, home, topology.expectedUid);
}

/** Open and authenticate HOME plus its parent without following leaf symlinks. */
export function openHomeLockTopology(
  homeDir?: string,
  expectedUid: number | undefined = currentUid(),
): HomeLockTopology {
  const homePath = resolve(homeDir ?? homedir());
  const parentPath = dirname(homePath);
  const flags = constants.O_RDONLY
    | constants.O_DIRECTORY
    | constants.O_NOFOLLOW
    | constants.O_NONBLOCK;
  let homeFd: number | undefined;
  const parentFd = openSync(parentPath, flags);
  try {
    homeFd = openSync(homePath, flags);
    const parent = directoryStat(parentFd);
    const home = directoryStat(homeFd);
    assertDirectoryIdentity(parent, parentPath, "HOME lock grandparent");
    assertDirectoryIdentity(home, homePath, "HOME lock parent");
    assertTopologySecurity(parent, home, expectedUid);
    return {
      homePath,
      parentPath,
      homeFd,
      parentFd,
      homeMode: Number(home.mode & 0o7777n),
      homeDev: home.dev,
      homeIno: home.ino,
      parentDev: parent.dev,
      parentIno: parent.ino,
      expectedUid,
    };
  } catch (error) {
    if (homeFd !== undefined) closeSync(homeFd);
    closeSync(parentFd);
    throw error;
  }
}

/** Restore the exact original HOME mode after a mutation lock tightened it. */
export function restoreHomeLockTopologyMode(topology: HomeLockTopology): void {
  if (topology.homeMode === 0o700) return;
  const home = directoryStat(topology.homeFd);
  if (
    home.dev === topology.homeDev
    && home.ino === topology.homeIno
    && Number(home.mode & 0o7777n) === 0o700
  ) {
    fchmodSync(topology.homeFd, topology.homeMode);
    fsyncSync(topology.homeFd);
  }
}

/** Close both retained descriptors after final restoration. */
export function closeHomeLockTopology(topology: HomeLockTopology): void {
  closeSync(topology.homeFd);
  closeSync(topology.parentFd);
}
