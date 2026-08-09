import {
  createHash,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const renameControl = vi.hoisted(() => ({
  error: undefined as NodeJS.ErrnoException | undefined,
  errorPredicate: undefined as ((from: string, to: string) => boolean) | undefined,
  beforeError: undefined as ((from: string, to: string) => void) | undefined,
  errorOnce: false,
  afterActiveRootAppears: undefined as (() => void) | undefined,
}));

const fsControl = vi.hoisted(() => ({
  fsyncError: undefined as NodeJS.ErrnoException | undefined,
  missingSecureOpenFlags: false,
  fstatHook: undefined as ((path: string, stat: unknown) => unknown) | undefined,
  closeHook: undefined as ((path: string, fd: number) => void) | undefined,
  readlinkError: undefined as NodeJS.ErrnoException | undefined,
  readlinkHook: undefined as ((path: string) => string | undefined) | undefined,
  statHook: undefined as ((path: string, stat: unknown) => unknown) | undefined,
  lstatHook: undefined as ((path: string, stat: unknown) => unknown) | undefined,
  lstatErrorPath: undefined as string | undefined,
  mkdirErrorPath: undefined as string | undefined,
  mkdirEexistPath: undefined as string | undefined,
  mkdirHook: undefined as ((path: string) => void) | undefined,
  linkError: undefined as NodeJS.ErrnoException | undefined,
  readdirHook: undefined as ((path: string, options: unknown, entries: unknown) => unknown) | undefined,
  fchmodHook: undefined as ((path: string, fd: number) => void) | undefined,
  writeHook: undefined as ((path: string, fd: number, content: Buffer) => void) | undefined,
  unlinkHook: undefined as ((path: string) => void) | undefined,
  rmdirHook: undefined as ((path: string) => void) | undefined,
  openHook: undefined as ((path: string, fd: number) => void) | undefined,
  openErrorPath: undefined as string | undefined,
  openErrorPattern: undefined as string | undefined,
  renameHook: undefined as ((from: string, to: string) => void) | undefined,
  lstatErrorPattern: undefined as string | undefined,
  lstatRacePath: undefined as string | undefined,
  lstatRaceCall: 0,
  lstatRaceCreate: undefined as ((path: string) => void) | undefined,
  lstatCalls: new Map<string, number>(),
  writeZero: false,
  fdPaths: new Map<number, string>(),
}));

const processControl = vi.hoisted(() => ({
  procStat: undefined as string | undefined,
  procStatError: undefined as Error | undefined,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    constants: {
      ...actual.constants,
      O_DIRECTORY: undefined,
      get O_NOFOLLOW(): number | undefined {
        return fsControl.missingSecureOpenFlags ? undefined : actual.constants.O_NOFOLLOW;
      },
      get O_NONBLOCK(): number | undefined {
        return fsControl.missingSecureOpenFlags ? undefined : actual.constants.O_NONBLOCK;
      },
    },
    openSync: (path: string, flags: number, mode?: number) => {
      if (fsControl.openErrorPath === path
        || (fsControl.openErrorPattern !== undefined && path.includes(fsControl.openErrorPattern))) {
        throw Object.assign(new Error("synthetic open failure"), { code: "EACCES" });
      }
      const fd = mode === undefined ? actual.openSync(path, flags) : actual.openSync(path, flags, mode);
      fsControl.fdPaths.set(fd, path);
      fsControl.openHook?.(path, fd);
      return fd;
    },
    fstatSync: (fd: number, options?: { bigint?: boolean }) => {
      const stat = actual.fstatSync(fd, options);
      const hook = fsControl.fstatHook;
      return hook === undefined
        ? stat
        : hook(fsControl.fdPaths.get(fd) ?? "", stat) as ReturnType<typeof actual.fstatSync>;
    },
    closeSync: (fd: number): void => {
      fsControl.closeHook?.(fsControl.fdPaths.get(fd) ?? "", fd);
      actual.closeSync(fd);
    },
    readlinkSync: (path: string): string => {
      if (fsControl.readlinkError !== undefined) throw fsControl.readlinkError;
      const result = fsControl.readlinkHook?.(path);
      if (result !== undefined) return result;
      return actual.readlinkSync(path);
    },
    statSync: (path: string, options?: { bigint?: boolean }) => {
      const stat = actual.statSync(path, options);
      const hook = fsControl.statHook;
      return hook === undefined ? stat : hook(path, stat) as ReturnType<typeof actual.statSync>;
    },
    lstatSync: (path: string, options?: { bigint?: boolean }) => {
      if (fsControl.lstatErrorPath === path) throw Object.assign(new Error("synthetic lstat failure"), { code: "EACCES" });
      if (fsControl.lstatErrorPattern !== undefined && path.includes(fsControl.lstatErrorPattern)) {
        throw Object.assign(new Error("synthetic cleanup lstat failure"), { code: "EACCES" });
      }
      const count = (fsControl.lstatCalls.get(path) ?? 0) + 1;
      fsControl.lstatCalls.set(path, count);
      if (fsControl.lstatRacePath === path && count === fsControl.lstatRaceCall) {
        const create = fsControl.lstatRaceCreate;
        fsControl.lstatRacePath = undefined;
        fsControl.lstatRaceCreate = undefined;
        create?.(path);
      }
      const stat = actual.lstatSync(path, options);
      return fsControl.lstatHook === undefined
        ? stat
        : fsControl.lstatHook(path, stat) as ReturnType<typeof actual.lstatSync>;
    },
    mkdirSync: (path: string, options?: { recursive?: boolean; mode?: number }) => {
      if (fsControl.mkdirErrorPath === path) throw Object.assign(new Error("synthetic mkdir failure"), { code: "EACCES" });
      if (fsControl.mkdirEexistPath === path) {
        fsControl.mkdirEexistPath = undefined;
        fsControl.mkdirHook?.(path);
        if (fsControl.mkdirHook === undefined) actual.mkdirSync(path, options);
        throw Object.assign(new Error("synthetic mkdir race"), { code: "EEXIST" });
      }
      const result = actual.mkdirSync(path, options);
      fsControl.mkdirHook?.(path);
      return result;
    },
    readdirSync: (path: string, options?: unknown) => {
      const entries = actual.readdirSync(path, options as never);
      return fsControl.readdirHook === undefined
        ? entries
        : fsControl.readdirHook(path, options, entries);
    },
    linkSync: (from: string, to: string): void => {
      if (fsControl.linkError) throw fsControl.linkError;
      actual.linkSync(from, to);
    },
    writeSync: (fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number => {
      if (fsControl.writeZero) return 0;
      const written = actual.writeSync(fd, buffer, offset, length, position);
      fsControl.writeHook?.(
        fsControl.fdPaths.get(fd) ?? "",
        fd,
        Buffer.from(buffer.subarray(offset, offset + written)),
      );
      return written;
    },
    fchmodSync: (fd: number, mode: number): void => {
      actual.fchmodSync(fd, mode);
      fsControl.fchmodHook?.(fsControl.fdPaths.get(fd) ?? "", fd);
    },
    unlinkSync: (path: string): void => {
      actual.unlinkSync(path);
      fsControl.unlinkHook?.(path);
    },
    rmdirSync: (path: string): void => {
      fsControl.rmdirHook?.(path);
      actual.rmdirSync(path);
    },
    fsyncSync: (fd: number): void => {
      if (fsControl.fsyncError && actual.fstatSync(fd, { bigint: true }).isDirectory()) throw fsControl.fsyncError;
      actual.fsyncSync(fd);
    },
    renameSync: (from: string, to: string): void => {
      if (renameControl.error
        && (renameControl.errorPredicate === undefined || renameControl.errorPredicate(from, to))) {
        renameControl.beforeError?.(from, to);
        const error = renameControl.error;
        if (renameControl.errorOnce) renameControl.error = undefined;
        throw error;
      }
      actual.renameSync(from, to);
      fsControl.renameHook?.(from, to);
      if (renameControl.afterActiveRootAppears !== undefined && String(to).endsWith("/.lcm")) {
        const competitor = renameControl.afterActiveRootAppears;
        renameControl.afterActiveRootAppears = undefined;
        competitor();
      }
    },
  };
});

vi.mock("../src/security-files.js", async () => {
  const actual = await vi.importActual<typeof import("../src/security-files.js")>("../src/security-files.js");
  return {
    ...actual,
    readBoundedRegularFile: (...args: Parameters<typeof actual.readBoundedRegularFile>): string => {
      const [path] = args;
      if (path.startsWith("/proc/") && processControl.procStatError !== undefined) {
        throw processControl.procStatError;
      }
      if (path.startsWith("/proc/") && processControl.procStat !== undefined) {
        return processControl.procStat;
      }
      return actual.readBoundedRegularFile(...args);
    },
  };
});
import {
  bootstrapLcmHome,
  legacyLcmHomeDir,
  lcmHomeDir,
  migrateLegacyHomeIfNeeded,
} from "../src/runtime-paths.js";
import { withBackendPublicationConsumerLock } from "../src/storage/backend-publication.js";

const homes: string[] = [];
afterEach(() => {
  renameControl.error = undefined;
  renameControl.errorPredicate = undefined;
  renameControl.beforeError = undefined;
  renameControl.errorOnce = false;
  renameControl.afterActiveRootAppears = undefined;
  fsControl.fsyncError = undefined;
  fsControl.missingSecureOpenFlags = false;
  fsControl.fstatHook = undefined;
  fsControl.closeHook = undefined;
  fsControl.readlinkError = undefined;
  fsControl.readlinkHook = undefined;
  fsControl.statHook = undefined;
  fsControl.lstatHook = undefined;
  fsControl.lstatErrorPath = undefined;
  fsControl.mkdirErrorPath = undefined;
  fsControl.mkdirEexistPath = undefined;
  fsControl.mkdirHook = undefined;
  fsControl.linkError = undefined;
  fsControl.readdirHook = undefined;
  fsControl.fchmodHook = undefined;
  fsControl.writeHook = undefined;
  fsControl.unlinkHook = undefined;
  fsControl.rmdirHook = undefined;
  fsControl.openHook = undefined;
  fsControl.openErrorPath = undefined;
  fsControl.openErrorPattern = undefined;
  fsControl.renameHook = undefined;
  fsControl.lstatErrorPattern = undefined;
  fsControl.lstatRacePath = undefined;
  fsControl.lstatRaceCall = 0;
  fsControl.lstatRaceCreate = undefined;
  fsControl.lstatCalls.clear();
  fsControl.writeZero = false;
  fsControl.fdPaths.clear();
  processControl.procStat = undefined;
  processControl.procStatError = undefined;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function legacyHome(): { home: string; legacy: string; next: string } {
  const home = mkdtempSync(join(tmpdir(), "lcm-runtime-errors-"));
  homes.push(home);
  const legacy = legacyLcmHomeDir(home);
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "value.txt"), "value");
  return { home, legacy, next: lcmHomeDir(home) };
}

function processStartTime(pid = process.pid): string | null {
  try {
    const content = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = content.lastIndexOf(")");
    if (commandEnd < 0) return null;
    return content.slice(commandEnd + 2).trim().split(/\s+/u)[19] ?? null;
  } catch {
    return null;
  }
}

function writeBootstrapLock(
  home: string,
  owner: { pid: number; processStartTime: string | null },
  nonce = "0123456789abcdef0123456789abcdef",
): string {
  const content = `${JSON.stringify({
    version: 1,
    pid: owner.pid,
    processStartTime: owner.processStartTime,
    nonce,
  })}\n`;
  const path = join(home, ".lcm-root-bootstrap.lock");
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  return content;
}

function writeBootstrapReclaimClaim(
  home: string,
  staleContent: string,
  owner: { pid: number; processStartTime: string | null },
  overrides: Record<string, unknown> = {},
): string {
  const lockPath = join(home, ".lcm-root-bootstrap.lock");
  const stale = JSON.parse(staleContent) as { nonce: string };
  const stat = lstatSync(lockPath, { bigint: true });
  const payload = {
    version: 1,
    pid: owner.pid,
    processStartTime: owner.processStartTime,
    nonce: "abcdef0123456789abcdef0123456789",
    sourceDev: String(stat.dev),
    sourceIno: String(stat.ino),
    sourceContentSha256: createHash("sha256").update(staleContent).digest("hex"),
    ...overrides,
  };
  const path = `${lockPath}.reclaim-${stale.nonce}`;
  const content = `${JSON.stringify(payload)}\n`;
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function nestedLegacyHome(): {
  paths: { home: string; legacy: string; next: string };
  container: string;
  replacementContainer: string;
  retainedContainer: string;
} {
  const container = mkdtempSync(join(tmpdir(), "lcm-runtime-container-"));
  const home = join(container, "home");
  mkdirSync(home, { mode: 0o700 });
  const legacy = legacyLcmHomeDir(home);
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "value.txt"), "value");
  const replacementContainer = mkdtempSync(join(tmpdir(), "lcm-runtime-replacement-container-"));
  const replacementHome = join(replacementContainer, "home");
  mkdirSync(replacementHome, { mode: 0o700 });
  const retainedContainer = `${container}.retained`;
  homes.push(container, replacementContainer, retainedContainer);
  return {
    paths: { home, legacy, next: lcmHomeDir(home) },
    container,
    replacementContainer,
    retainedContainer,
  };
}

function descriptorPathTargets(candidate: string, target: string): boolean {
  if (candidate === target) return true;
  const match = /^(\/proc\/self\/fd|\/dev\/fd)\/(\d+)(?:\/(.*))?$/u.exec(candidate);
  if (match === null) return false;
  let descriptorTarget: string;
  try {
    descriptorTarget = readlinkSync(`${match[1]}/${match[2]}`).replace(/ \(deleted\)$/u, "");
  } catch {
    return false;
  }
  return match[3] === undefined ? descriptorTarget === target : join(descriptorTarget, match[3]) === target;
}

function swapDirectoryPath(path: string, replacement: string, retainedOriginal: string): void {
  renameSync(path, retainedOriginal);
  renameSync(replacement, path);
}

function restoreDirectoryPath(path: string, replacement: string, retainedOriginal: string): void {
  renameSync(path, replacement);
  renameSync(retainedOriginal, path);
}

function replacementLegacyRoot(home: string, content = "replacement"): void {
  const path = legacyLcmHomeDir(home);
  mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(path, "value.txt"), content, { mode: 0o600 });
}

function armForRetaining(content: Buffer): boolean {
  return content.toString().includes('"phase":"retaining"');
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function treeWitness(root: string): Record<string, unknown> {
  const hash = createHash("sha256");
  const update = (label: string, value: string | Buffer): void => {
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    hash.update(`${label}\0${bytes.byteLength}\0`);
    hash.update(bytes);
  };
  const visit = (path: string, relative: string, rootEntry: boolean): void => {
    const stat = lstatSync(path, { bigint: true });
    const directory = stat.isDirectory();
    update("path", relative);
    update("kind", directory ? "directory" : "file");
    if (!rootEntry) update("mode", String(Number(stat.mode & 0o7777n)));
    if (directory) {
      for (const name of readdirSync(path).sort()) {
        visit(join(path, name), relative ? `${relative}/${name}` : name, false);
      }
    } else {
      update("bytes", readFileSync(path));
    }
  };
  const stat = lstatSync(root, { bigint: true });
  visit(root, "", true);
  return {
    identity: { dev: String(stat.dev), ino: String(stat.ino) },
    mode: Number(stat.mode & 0o7777n),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    hash: hash.digest("hex"),
  };
}

function copyingJournal(
  home: string,
  source: string,
  staging: string,
  phase: "copying" | "published" = "copying",
  targetPath = staging,
): void {
  const operationId = "0123456789abcdef0123456789abcdef0123456789abcdef";
  const stagingName = basename(staging);
  const sourceWitness = treeWitness(source);
  const targetWitness = treeWitness(targetPath);
  const payload = {
    version: 1,
    phase,
    operationId,
    sourceName: ".lossless-claude",
    targetName: ".lcm",
    stagingName,
    source: sourceWitness,
    target: targetWitness,
    targetBaseHash: targetWitness.hash,
  };
  const journal = { ...payload, checksumSha256: createHash("sha256").update(canonical(payload)).digest("hex") };
  writeFileSync(join(home, ".lcm-legacy-migration.json"), `${canonical(journal)}\n`, { mode: 0o600 });
}

function retainedJournal(
  home: string,
  source: string,
  target: string,
  staging: string,
  phase: "published" | "retaining",
  retainedPath: string | null,
): void {
  const payload = {
    version: 2,
    phase,
    operationId: "0123456789abcdef0123456789abcdef0123456789abcdef",
    sourceName: ".lossless-claude",
    targetName: ".lcm",
    stagingName: basename(staging),
    source: treeWitness(source),
    target: treeWitness(target),
    retained: retainedPath === null ? null : treeWitness(retainedPath),
    targetBaseHash: null,
  };
  const journal = { ...payload, checksumSha256: createHash("sha256").update(canonical(payload)).digest("hex") };
  writeFileSync(join(home, ".lcm-legacy-migration.json"), `${canonical(journal)}\n`, { mode: 0o600 });
}

describe("runtime home rename failures", () => {
  it("fails closed when the platform has no descriptor namespace", () => {
    const paths = legacyHome();
    fsControl.readlinkError = Object.assign(new Error("descriptor namespace unavailable"), { code: "ENOENT" });

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("requires descriptor-relative filesystem access");
    expect(existsSync(paths.legacy)).toBe(true);
    expect(existsSync(paths.next)).toBe(false);
  });

  it("fails closed when no-follow or nonblocking descriptor flags are unavailable", () => {
    const paths = legacyHome();
    fsControl.missingSecureOpenFlags = true;

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("requires no-follow nonblocking descriptor access");
    expect(existsSync(paths.legacy)).toBe(true);
    expect(existsSync(paths.next)).toBe(false);
  });

  it("preserves an unexpected descriptor namespace error", () => {
    const paths = legacyHome();
    fsControl.readlinkError = Object.assign(new Error("descriptor namespace denied"), { code: "EACCES" });

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("descriptor namespace denied");
  });

  it("treats a macOS-style descriptor readlink EINVAL as an unavailable namespace", () => {
    const paths = legacyHome();
    fsControl.readlinkError = Object.assign(
      new Error("macOS descriptor entries are not symbolic links"),
      { code: "EINVAL" },
    );

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(
      "legacy migration requires descriptor-relative filesystem access",
    );
    expect(existsSync(paths.legacy)).toBe(true);
    expect(existsSync(paths.next)).toBe(false);
  });

  it("opens the legacy root before a pathname-stat ABA can redirect its witness", () => {
    const nested = nestedLegacyHome();
    const { paths } = nested;
    replacementLegacyRoot(join(nested.replacementContainer, "home"), "replacement-witness");
    let swapped = false;
    fsControl.lstatHook = (path, stat) => {
      if (!swapped && descriptorPathTargets(path, paths.legacy)) {
        swapDirectoryPath(nested.container, nested.replacementContainer, nested.retainedContainer);
        swapped = true;
      }
      return stat;
    };
    fsControl.readdirHook = (path, options, entries) => {
      if (swapped && (options as { withFileTypes?: boolean } | undefined)?.withFileTypes) {
        restoreDirectoryPath(nested.container, nested.replacementContainer, nested.retainedContainer);
        swapped = false;
        fsControl.lstatHook = undefined;
      }
      return entries;
    };

    try {
      expect(migrateLegacyHomeIfNeeded(paths.home)).toEqual({ migrated: true, from: paths.legacy, to: paths.next });
      expect(readFileSync(join(paths.next, "value.txt"), "utf-8")).toBe("value");
    } finally {
      if (swapped) restoreDirectoryPath(nested.container, nested.replacementContainer, nested.retainedContainer);
    }
  });

  it("keeps witness hashing bound to the authenticated directory during an ABA root swap", () => {
    const nested = nestedLegacyHome();
    const { paths } = nested;
    replacementLegacyRoot(join(nested.replacementContainer, "home"), "replacement-witness");
    let armed = true;
    let swapped = false;
    let sourceFileFstats = 0;
    fsControl.readdirHook = (path, options, entries) => {
      const sourceDirectory = descriptorPathTargets(path, paths.legacy);
      if (armed && !swapped && sourceDirectory && (options as { withFileTypes?: boolean } | undefined)?.withFileTypes) {
        swapDirectoryPath(nested.container, nested.replacementContainer, nested.retainedContainer);
        swapped = true;
      } else if (swapped && sourceDirectory && options === undefined) {
        restoreDirectoryPath(nested.container, nested.replacementContainer, nested.retainedContainer);
        swapped = false;
        armed = false;
      }
      return entries;
    };
    fsControl.fstatHook = (path, stat) => {
      if (swapped && path.endsWith("/value.txt") && ++sourceFileFstats === 2) {
        restoreDirectoryPath(nested.container, nested.replacementContainer, nested.retainedContainer);
        swapped = false;
        armed = false;
      }
      return stat;
    };

    expect(migrateLegacyHomeIfNeeded(paths.home)).toEqual({
      migrated: true,
      from: paths.legacy,
      to: paths.next,
    });
    expect(readFileSync(join(paths.next, "value.txt"), "utf-8")).toBe("value");
  });

  it("keeps recursive copy bound to the authenticated source during an ABA root swap", () => {
    const nested = nestedLegacyHome();
    const { paths } = nested;
    replacementLegacyRoot(join(nested.replacementContainer, "home"), "replacement-copy");
    let armed = false;
    let swapped = false;
    let sourceFileFstats = 0;
    fsControl.writeHook = (_path, _fd, content) => {
      if (content.toString().includes('"phase":"copying"')) armed = true;
    };
    fsControl.readdirHook = (path, options, entries) => {
      const sourceDirectory = descriptorPathTargets(path, paths.legacy);
      if (armed && !swapped && sourceDirectory && (options as { withFileTypes?: boolean } | undefined)?.withFileTypes) {
        swapDirectoryPath(nested.container, nested.replacementContainer, nested.retainedContainer);
        swapped = true;
      } else if (armed && swapped && options === undefined) {
        restoreDirectoryPath(nested.container, nested.replacementContainer, nested.retainedContainer);
        armed = false;
      }
      return entries;
    };
    fsControl.fstatHook = (path, stat) => {
      if (armed && swapped && path.endsWith("/value.txt") && ++sourceFileFstats === 2) {
        restoreDirectoryPath(nested.container, nested.replacementContainer, nested.retainedContainer);
        swapped = false;
        armed = false;
      }
      return stat;
    };

    expect(migrateLegacyHomeIfNeeded(paths.home)).toEqual({
      migrated: true,
      from: paths.legacy,
      to: paths.next,
    });
    expect(readFileSync(join(paths.next, "value.txt"), "utf-8")).toBe("value");
  });

  it("rejects a staging target replaced before descriptor-bound recursive copy", () => {
    const paths = legacyHome();
    let armed = false;
    fsControl.writeHook = (_path, _fd, content) => {
      if (!armed && content.toString().includes('"phase":"copying"')) {
        const stagingName = readdirSync(paths.home).find((name) => name.endsWith(".partial"));
        if (stagingName === undefined) throw new Error("test staging path is missing");
        const staging = join(paths.home, stagingName);
        rmSync(staging, { recursive: true, force: true });
        writeFileSync(staging, "replacement", { mode: 0o600 });
        armed = true;
      }
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("migration target directory is not a directory");
  });

  it("rejects a source that becomes a regular file before descriptor-bound copy", () => {
    const paths = legacyHome();
    let armed = false;
    fsControl.writeHook = (_path, _fd, content) => {
      if (!armed && content.toString().includes('"phase":"copying"')) {
        rmSync(paths.legacy, { recursive: true, force: true });
        writeFileSync(paths.legacy, "replacement", { mode: 0o600 });
        armed = true;
      }
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("legacy migration source is not a directory");
  });

  it("preserves an unexpected staging descriptor open failure", () => {
    const paths = legacyHome();
    let armed = false;
    fsControl.writeHook = (_path, _fd, content) => {
      if (!armed && content.toString().includes('"phase":"copying"')) {
        const stagingName = readdirSync(paths.home).find((name) => name.endsWith(".partial"));
        if (stagingName === undefined) throw new Error("test staging path is missing");
        fsControl.openErrorPath = join(paths.home, stagingName);
        armed = true;
      }
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("synthetic open failure");
  });

  it("retains outside data when the legacy root is substituted at the terminal boundary", () => {
    const paths = legacyHome();
    const outside = join(paths.home, "outside-removal-root");
    mkdirSync(outside, { mode: 0o700 });
    writeFileSync(join(outside, "value.txt"), "outside", { mode: 0o600 });
    const retainedOriginal = join(paths.home, "retained-removal-root");
    let substituted = false;
    fsControl.writeHook = (_path, _fd, content) => {
      if (!substituted && content.toString().includes('"phase":"retained"')) {
        substituted = true;
        renameSync(paths.legacy, retainedOriginal);
        symlinkSync(outside, paths.legacy);
      }
    };

    expect(migrateLegacyHomeIfNeeded(paths.home)).toMatchObject({ migrated: true, to: paths.next });
    expect(readFileSync(join(outside, "value.txt"), "utf-8")).toBe("outside");
    expect(readFileSync(join(retainedOriginal, "value.txt"), "utf-8")).toBe("value");
  });

  it("does not revalidate a replaced legacy root after entering the terminal phase", () => {
    const paths = legacyHome();
    const replacement = join(paths.home, "replacement-removal-root");
    const retainedOriginal = join(paths.home, "retained-removal-root");
    mkdirSync(replacement, { mode: 0o700 });
    writeFileSync(join(replacement, "value.txt"), "replacement", { mode: 0o600 });
    let replaced = false;
    fsControl.writeHook = (_path, _fd, content) => {
      if (!replaced && content.toString().includes('"phase":"retained"')) {
        replaced = true;
        renameSync(paths.legacy, retainedOriginal);
        renameSync(replacement, paths.legacy);
      }
    };

    expect(migrateLegacyHomeIfNeeded(paths.home)).toMatchObject({ migrated: true, to: paths.next });
    expect(migrateLegacyHomeIfNeeded(paths.home)).toMatchObject({ migrated: true, to: paths.next });
    expect(readFileSync(join(paths.legacy, "value.txt"), "utf-8")).toBe("replacement");
  });

  it("rejects a legacy root replaced during retained evidence copy", () => {
    const paths = legacyHome();
    const replacement = join(paths.home, "replacement-after-auth-root");
    const retainedOriginal = join(paths.home, "retained-after-auth-root");
    mkdirSync(replacement, { mode: 0o700 });
    writeFileSync(join(replacement, "value.txt"), "replacement", { mode: 0o600 });
    let armed = false;
    fsControl.writeHook = (_path, _fd, content) => {
      if (armForRetaining(content)) armed = true;
    };
    fsControl.closeHook = (path) => {
      if (armed && path === paths.legacy) {
        armed = false;
        renameSync(paths.legacy, retainedOriginal);
        renameSync(replacement, paths.legacy);
      }
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(/source changed|path changed|retaining root changed/);
    expect(readFileSync(join(paths.legacy, "value.txt"), "utf-8")).toBe("replacement");
  });

  it("retains a replacement installed between the final child check and unlink", () => {
    const paths = legacyHome();
    const outside = join(paths.home, "outside-child");
    mkdirSync(outside, { mode: 0o700 });
    writeFileSync(join(outside, "value.txt"), "outside", { mode: 0o600 });
    let substituted = false;
    fsControl.writeHook = (_path, _fd, content) => {
      if (!substituted && content.toString().includes('"phase":"retained"')) {
        substituted = true;
        const retainedOriginal = join(paths.home, "retained-child-root");
        renameSync(paths.legacy, retainedOriginal);
        symlinkSync(outside, paths.legacy);
      }
    };

    expect(migrateLegacyHomeIfNeeded(paths.home)).toMatchObject({ migrated: true, to: paths.next });
    expect(readFileSync(join(outside, "value.txt"), "utf-8")).toBe("outside");
  });

  it("does not call rmdir after the final root check", () => {
    const paths = legacyHome();
    const outside = join(paths.home, "outside-empty-root");
    mkdirSync(outside, { mode: 0o700 });
    let armed = false;
    let rmdirCalled = false;
    fsControl.writeHook = (_path, _fd, content) => {
      if (content.toString().includes('"phase":"retained"')) armed = true;
    };
    fsControl.rmdirHook = (path) => {
      if (armed && descriptorPathTargets(path, paths.legacy)) {
        armed = false;
        const retainedOriginal = join(paths.home, "retained-empty-root");
        renameSync(paths.legacy, retainedOriginal);
        renameSync(outside, paths.legacy);
      }
      rmdirCalled = true;
    };

    expect(migrateLegacyHomeIfNeeded(paths.home)).toEqual({
      migrated: true,
      from: paths.legacy,
      to: paths.next,
    });
    expect(rmdirCalled).toBe(false);
    expect(existsSync(outside)).toBe(true);
  });

  it("treats an already absent migration journal as idempotent cleanup", () => {
    const paths = legacyHome();
    const active = paths.next;
    mkdirSync(active, { mode: 0o700 });
    writeFileSync(join(active, "value.txt"), "value", { mode: 0o600 });
    const journalPath = join(paths.home, ".lcm-legacy-migration.json");
    const operationId = "0123456789abcdef0123456789abcdef0123456789abcdef";
    const staging = join(paths.home, ".lcm-legacy-migration-"
      + createHash("sha256").update(`.lcm\0${operationId}`).digest("hex")
      + ".partial");
    copyingJournal(paths.home, paths.legacy, staging, "published", active);
    rmSync(paths.legacy, { recursive: true, force: true });
    let journalLstats = 0;
    fsControl.lstatHook = (path, stat) => {
      if (path === journalPath && ++journalLstats === 1) {
        rmSync(journalPath, { force: true });
        throw Object.assign(new Error("journal already removed"), { code: "ENOENT" });
      }
      return stat;
    };

    expect(migrateLegacyHomeIfNeeded(paths.home)).toMatchObject({ migrated: true, to: active });
  });

  it("publishes a bound copy while retaining authenticated source evidence for recovery", () => {
    const paths = legacyHome();

    expect(migrateLegacyHomeIfNeeded(paths.home)).toEqual({
      migrated: true,
      from: paths.legacy,
      to: paths.next,
    });
    expect(readFileSync(join(paths.next, "value.txt"), "utf-8")).toBe("value");
    expect(readFileSync(join(paths.legacy, "value.txt"), "utf-8")).toBe("value");
    expect(existsSync(join(paths.home, ".lcm-legacy-migration.json"))).toBe(true);
  });

  it("falls back to copy-and-remove for cross-device renames", () => {
    const paths = legacyHome();
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    expect(migrateLegacyHomeIfNeeded(paths.home)).toEqual({
      migrated: true,
      from: paths.legacy,
      to: paths.next,
    });
    expect(readFileSync(join(paths.next, "value.txt"), "utf-8")).toBe("value");
    expect(existsSync(paths.legacy)).toBe(true);
  });

  it("rethrows non-cross-device rename failures", () => {
    const paths = legacyHome();
    renameControl.error = Object.assign(new Error("denied"), { code: "EACCES" });
    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("denied");
  });

  it("continues when directory fsync is explicitly unsupported", () => {
    const paths = legacyHome();
    fsControl.fsyncError = Object.assign(new Error("directory sync unsupported"), { code: "EINVAL" });

    expect(migrateLegacyHomeIfNeeded(paths.home).migrated).toBe(true);
    expect(existsSync(paths.legacy)).toBe(true);
  });

  it("fails closed on an unexpected durability error", () => {
    const paths = legacyHome();
    fsControl.fsyncError = Object.assign(new Error("durability failed"), { code: "EIO" });

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("durability failed");
    expect(existsSync(paths.legacy)).toBe(true);
  });

  it("rejects a home identity change during descriptor validation", () => {
    const paths = legacyHome();
    let changed = false;
    fsControl.statHook = (path, stat) => {
      if (path === paths.home && !changed) {
        changed = true;
        return { ...(stat as object), ino: (stat as { ino: bigint }).ino + 1n };
      }
      return stat;
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("home directory changed during validation");
  });

  it("preserves a non-missing lstat failure", () => {
    const paths = legacyHome();
    fsControl.lstatErrorPath = paths.legacy;

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("synthetic lstat failure");
  });

  it("preserves a root creation mkdir failure", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-mkdir-"));
    homes.push(home);
    fsControl.mkdirErrorPath = lcmHomeDir(home);

    expect(() => bootstrapLcmHome(home)).toThrow("synthetic mkdir failure");
  });

  it("accepts a root that appears during the non-recursive mkdir race", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-root-race-"));
    homes.push(home);
    fsControl.mkdirEexistPath = lcmHomeDir(home);

    expect(bootstrapLcmHome(home)).toMatchObject({ created: true, migrated: false });
    expect(existsSync(lcmHomeDir(home))).toBe(true);
  });

  it.each(["regular file", "symlink"])("rejects an unsafe root that appears before private-root validation (%s)", (kind) => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-root-appearance-"));
    homes.push(home);
    const root = lcmHomeDir(home);
    const outside = join(home, "outside");
    writeFileSync(outside, "outside");
    fsControl.lstatRacePath = root;
    fsControl.lstatRaceCall = 5;
    fsControl.lstatRaceCreate = (path) => {
      if (kind === "regular file") writeFileSync(path, "not a directory");
      else symlinkSync(outside, path);
    };

    expect(() => bootstrapLcmHome(home)).toThrow("private LCM root is not a directory");
  });

  it("reuses a trusted directory that appears before private-root creation", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-root-directory-race-"));
    homes.push(home);
    fsControl.lstatRacePath = lcmHomeDir(home);
    fsControl.lstatRaceCall = 5;
    fsControl.lstatRaceCreate = (path) => mkdirSync(path, { mode: 0o700 });

    expect(bootstrapLcmHome(home)).toMatchObject({ created: true, migrated: false });
  });

  it("rejects a root changed between creation and publication handoff", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-root-handoff-"));
    homes.push(home);
    const root = lcmHomeDir(home);
    let rootCloses = 0;
    fsControl.closeHook = (path) => {
      if (path === root && ++rootCloses === 2) chmodSync(root, 0o755);
    };

    expect(() => bootstrapLcmHome(home)).toThrow("changed before bootstrap handoff");
  });

  it("rejects a non-directory home descriptor", () => {
    const container = mkdtempSync(join(tmpdir(), "lcm-runtime-file-home-"));
    homes.push(container);
    const home = join(container, "home-file");
    writeFileSync(home, "not a directory");

    expect(() => bootstrapLcmHome(home)).toThrow("home directory is not a directory");
  });

  it("accepts a root-owned sticky parent as an authenticated home parent", () => {
    const home = mkdtempSync("/tmp/lcm-runtime-sticky-parent-");
    homes.push(home);

    expect(bootstrapLcmHome(home)).toMatchObject({ created: true, migrated: false });
  });

  it("propagates a non-exclusive bootstrap-lock open failure", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-open-"));
    homes.push(home);
    fsControl.openErrorPath = join(home, ".lcm-root-bootstrap.lock");

    expect(() => bootstrapLcmHome(home)).toThrow("synthetic open failure");
  });

  it("cleans up a newly opened bootstrap lock that fails metadata authentication", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-new-meta-"));
    homes.push(home);
    const lockPath = join(home, ".lcm-root-bootstrap.lock");
    fsControl.fstatHook = (path, stat) => path === lockPath
      ? Object.assign(stat as object, { mode: 0o644n })
      : stat;

    expect(() => bootstrapLcmHome(home)).toThrow("new bootstrap lock did not authenticate");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("reports a bootstrap lock content change during owned release", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-release-content-"));
    homes.push(home);
    const lockPath = join(home, ".lcm-root-bootstrap.lock");
    let tampered = false;
    fsControl.writeHook = (path) => {
      if (!tampered && path === lockPath) {
        tampered = true;
        writeFileSync(path, "tampered\n", { mode: 0o600 });
        chmodSync(path, 0o600);
      }
    };

    expect(() => bootstrapLcmHome(home)).toThrow("changed before release");
    expect(readFileSync(lockPath, "utf8")).toBe("tampered\n");
  });

  it("reports a bootstrap lock read failure during owned release", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-release-read-"));
    homes.push(home);
    const lockPath = join(home, ".lcm-root-bootstrap.lock");
    let armed = false;
    fsControl.writeHook = (path) => {
      if (path === lockPath) {
        armed = true;
        fsControl.openErrorPath = lockPath;
      }
    };

    expect(() => bootstrapLcmHome(home)).toThrow("changed before release");
    expect(armed).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("fails closed when the newly created root does not retain private metadata", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-root-meta-"));
    homes.push(home);
    let rootFstats = 0;
    fsControl.fstatHook = (path, stat) => {
      if (path === lcmHomeDir(home) && ++rootFstats === 3) {
        return { ...(stat as object), mode: 0o755n };
      }
      return stat;
    };

    expect(() => bootstrapLcmHome(home)).toThrow("did not authenticate");
  });

  it("fails closed when a bootstrap lock write makes no progress", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-write-"));
    homes.push(home);
    fsControl.writeZero = true;

    expect(() => bootstrapLcmHome(home)).toThrow("made no progress");
  });

  it("cleans up when the temporary migration journal cannot be opened", () => {
    const paths = legacyHome();
    fsControl.openErrorPattern = ".lcm-legacy-migration.json.";

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("synthetic open failure");
  });

  it("rejects an existing bootstrap lock", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-existing-"));
    homes.push(home);
    writeFileSync(join(home, ".lcm-root-bootstrap.lock"), "another process\n", { mode: 0o600 });

    expect(() => bootstrapLcmHome(home)).toThrow("could not be authenticated");
  });

  it("rejects a bootstrap lock with tampered owner metadata", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-tampered-"));
    homes.push(home);
    writeFileSync(join(home, ".lcm-root-bootstrap.lock"), `${JSON.stringify({
      version: 1,
      pid: process.pid + 1_000_000,
      processStartTime: "1",
      nonce: "0123456789abcdef0123456789abcdef",
      extra: true,
    })}\n`, { mode: 0o600 });

    expect(() => bootstrapLcmHome(home)).toThrow("unexpected fields");
    expect(existsSync(join(home, ".lcm-root-bootstrap.lock"))).toBe(true);
  });

  it.each([
    ["a non-object JSON value", "null"],
    ["an invalid owner nonce", JSON.stringify({
      version: 1,
      pid: process.pid + 1_000_000,
      processStartTime: "1",
      nonce: "bad",
    })],
  ])("rejects %s in bootstrap owner metadata", (_label, serialized) => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-owner-invalid-"));
    homes.push(home);
    writeFileSync(join(home, ".lcm-root-bootstrap.lock"), `${serialized}\n`, { mode: 0o600 });

    expect(() => bootstrapLcmHome(home)).toThrow("metadata");
    expect(existsSync(join(home, ".lcm-root-bootstrap.lock"))).toBe(true);
  });

  it("rejects an oversized bootstrap lock without reading owner metadata", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-oversized-"));
    homes.push(home);
    writeFileSync(join(home, ".lcm-root-bootstrap.lock"), "x".repeat(1025), { mode: 0o600 });

    expect(() => bootstrapLcmHome(home)).toThrow("exceeds the configured size limit");
    expect(existsSync(join(home, ".lcm-root-bootstrap.lock"))).toBe(true);
  });

  it("rejects a symlink bootstrap lock without touching its target", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-symlink-"));
    homes.push(home);
    const outside = join(home, "outside-lock");
    writeFileSync(outside, "outside", { mode: 0o600 });
    symlinkSync(outside, join(home, ".lcm-root-bootstrap.lock"));

    expect(() => bootstrapLcmHome(home)).toThrow("could not be authenticated");
    expect(readFileSync(outside, "utf8")).toBe("outside");
  });

  it("rejects a bootstrap lock with a non-owner-only mode", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-mode-"));
    homes.push(home);
    writeBootstrapLock(home, { pid: process.pid + 1_000_000, processStartTime: "1" });
    chmodSync(join(home, ".lcm-root-bootstrap.lock"), 0o644);

    expect(() => bootstrapLcmHome(home)).toThrow("file mode is not trusted");
    expect(existsSync(join(home, ".lcm-root-bootstrap.lock"))).toBe(true);
  });

  it("fails closed when the owner liveness permission probe is denied", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-permission-"));
    homes.push(home);
    writeBootstrapLock(home, { pid: process.pid, processStartTime: "1" });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    });

    try {
      expect(() => bootstrapLcmHome(home)).toThrow("owner state is ambiguous");
      expect(existsSync(join(home, ".lcm-root-bootstrap.lock"))).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });

  it("fails closed when process-start metadata is malformed or unavailable", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-process-stat-"));
    homes.push(home);
    writeBootstrapLock(home, { pid: process.pid, processStartTime: "1" });
    processControl.procStat = "malformed) process stat";

    expect(() => bootstrapLcmHome(home)).toThrow("owner state is ambiguous");
    expect(existsSync(join(home, ".lcm-root-bootstrap.lock"))).toBe(true);
  });

  it("fails closed when process stat has no command terminator", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-process-stat-shape-"));
    homes.push(home);
    writeBootstrapLock(home, { pid: process.pid, processStartTime: "1" });
    processControl.procStat = "malformed process stat";

    expect(() => bootstrapLcmHome(home)).toThrow("owner state is ambiguous");
    expect(existsSync(join(home, ".lcm-root-bootstrap.lock"))).toBe(true);
  });

  it("records an unavailable process-start witness without reclaiming a lock", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-process-stat-error-"));
    homes.push(home);
    writeBootstrapLock(home, { pid: process.pid, processStartTime: "1" });
    processControl.procStatError = new Error("process stat unavailable");

    expect(() => bootstrapLcmHome(home)).toThrow("owner state is ambiguous");
    expect(existsSync(join(home, ".lcm-root-bootstrap.lock"))).toBe(true);
  });

  it("can reclaim the same definitively stale lock record again after replay", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-replay-"));
    homes.push(home);
    const content = writeBootstrapLock(home, {
      pid: process.pid + 1_000_000,
      processStartTime: "1",
    });

    expect(bootstrapLcmHome(home)).toMatchObject({ created: true, migrated: false });
    writeFileSync(join(home, ".lcm-root-bootstrap.lock"), content, { mode: 0o600 });
    chmodSync(join(home, ".lcm-root-bootstrap.lock"), 0o600);

    expect(bootstrapLcmHome(home)).toMatchObject({ created: false, migrated: false });
    expect(existsSync(join(home, ".lcm-root-bootstrap.lock"))).toBe(false);
  });

  it("removes a dead recovery claim before taking over its stale lock", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-dead-claim-"));
    homes.push(home);
    const stale = writeBootstrapLock(home, { pid: process.pid + 1_000_000, processStartTime: "1" });
    const claimPath = writeBootstrapReclaimClaim(home, stale, {
      pid: process.pid + 1_000_001,
      processStartTime: "1",
    });

    expect(bootstrapLcmHome(home)).toMatchObject({ created: true, migrated: false });
    expect(existsSync(claimPath)).toBe(false);
    expect(existsSync(join(home, ".lcm-root-bootstrap.lock"))).toBe(false);
  });

  it("stops after repeated stale recovery-claim replacement", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-claim-repeat-"));
    homes.push(home);
    const stale = writeBootstrapLock(home, { pid: process.pid + 1_000_000, processStartTime: "1" });
    const claimPath = writeBootstrapReclaimClaim(home, stale, {
      pid: process.pid + 1_000_001,
      processStartTime: "1",
    });
    const claimContent = readFileSync(claimPath, "utf8");
    let recreated = false;
    fsControl.unlinkHook = (path) => {
      if (!recreated && path === claimPath) {
        recreated = true;
        writeFileSync(claimPath, claimContent, { mode: 0o600 });
        chmodSync(claimPath, 0o600);
      }
    };

    expect(() => bootstrapLcmHome(home)).toThrow("changed repeatedly");
    expect(existsSync(claimPath)).toBe(false);
    expect(existsSync(join(home, ".lcm-root-bootstrap.lock"))).toBe(true);
  });

  it.each([
    ["malformed", "{"],
    ["non-object", "null"],
    ["unexpected fields", JSON.stringify({ extra: true })],
  ])("fails closed for %s recovery-claim metadata", (_label, serialized) => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-claim-malformed-"));
    homes.push(home);
    const stale = writeBootstrapLock(home, { pid: process.pid + 1_000_000, processStartTime: "1" });
    const claimPath = writeBootstrapReclaimClaim(home, stale, {
      pid: process.pid + 1_000_001,
      processStartTime: "1",
    });
    writeFileSync(claimPath, `${serialized}\n`, { mode: 0o600 });
    chmodSync(claimPath, 0o600);

    expect(() => bootstrapLcmHome(home)).toThrow("claim");
    expect(existsSync(claimPath)).toBe(true);
    expect(existsSync(join(home, ".lcm-root-bootstrap.lock"))).toBe(true);
  });

  it("fails closed for a recovery claim with mismatched source evidence", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-claim-mismatch-"));
    homes.push(home);
    const stale = writeBootstrapLock(home, { pid: process.pid + 1_000_000, processStartTime: "1" });
    const claimPath = writeBootstrapReclaimClaim(home, stale, {
      pid: process.pid + 1_000_001,
      processStartTime: "1",
    }, { sourceDev: "999999999" });

    expect(() => bootstrapLcmHome(home)).toThrow("does not match the stale lock");
    expect(existsSync(claimPath)).toBe(true);
    expect(existsSync(join(home, ".lcm-root-bootstrap.lock"))).toBe(true);
  });

  it("rejects recovery claims with malformed source metadata", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-claim-source-"));
    homes.push(home);
    const stale = writeBootstrapLock(home, { pid: process.pid + 1_000_000, processStartTime: "1" });
    const claimPath = writeBootstrapReclaimClaim(home, stale, {
      pid: process.pid + 1_000_001,
      processStartTime: "1",
    }, { sourceContentSha256: "bad" });

    expect(() => bootstrapLcmHome(home)).toThrow("source metadata is invalid");
    expect(existsSync(claimPath)).toBe(true);
  });

  it("fails closed when a recovery claim owner has ambiguous liveness", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-claim-ambiguous-"));
    homes.push(home);
    const stale = writeBootstrapLock(home, { pid: process.pid + 1_000_000, processStartTime: "1" });
    const claimPath = writeBootstrapReclaimClaim(home, stale, {
      pid: process.pid,
      processStartTime: null,
    });

    expect(() => bootstrapLcmHome(home)).toThrow("reclaim owner state is ambiguous");
    expect(existsSync(claimPath)).toBe(true);
    expect(existsSync(join(home, ".lcm-root-bootstrap.lock"))).toBe(true);
  });

  it("propagates a reclaim-claim open failure without changing the stale lock", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-claim-open-"));
    homes.push(home);
    const stale = writeBootstrapLock(home, { pid: process.pid + 1_000_000, processStartTime: "1" });
    const claimPath = `${join(home, ".lcm-root-bootstrap.lock")}.reclaim-0123456789abcdef0123456789abcdef`;
    fsControl.openErrorPath = claimPath;

    expect(() => bootstrapLcmHome(home)).toThrow("synthetic open failure");
    expect(existsSync(claimPath)).toBe(false);
    expect(readFileSync(join(home, ".lcm-root-bootstrap.lock"), "utf8")).toBe(stale);
  });

  it("cleans a reclaim claim after its durable write makes no progress", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-claim-write-"));
    homes.push(home);
    writeBootstrapLock(home, { pid: process.pid + 1_000_000, processStartTime: "1" });
    fsControl.writeZero = true;

    expect(() => bootstrapLcmHome(home)).toThrow("made no progress");
    expect(readdirSync(home).some((entry) => entry.includes(".reclaim-"))).toBe(false);
  });

  it("fails closed when a newly created reclaim claim does not authenticate", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-claim-meta-"));
    homes.push(home);
    writeBootstrapLock(home, { pid: process.pid + 1_000_000, processStartTime: "1" });
    const claimPath = `${join(home, ".lcm-root-bootstrap.lock")}.reclaim-0123456789abcdef0123456789abcdef`;
    fsControl.fstatHook = (path, stat) => path === claimPath
      ? Object.assign(stat as object, { mode: 0o644n })
      : stat;

    expect(() => bootstrapLcmHome(home)).toThrow("new bootstrap reclaim claim did not authenticate");
    expect(existsSync(claimPath)).toBe(false);
  });

  it("cleans an operation-owned claim after its topology changes", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-claim-topology-"));
    homes.push(home);
    writeBootstrapLock(home, { pid: process.pid + 1_000_000, processStartTime: "1" });
    let claimWritten = false;
    fsControl.writeHook = (path) => {
      if (path.includes(".lcm-root-bootstrap.lock.reclaim-")) claimWritten = true;
    };
    fsControl.statHook = (path, stat) => claimWritten && path === home
      ? Object.assign(stat as object, { ino: (stat as { ino: bigint }).ino + 1n })
      : stat;

    expect(() => bootstrapLcmHome(home)).toThrow("home directory changed during validation");
    expect(readdirSync(home).some((entry) => entry.includes(".reclaim-"))).toBe(false);
  });

  it("preserves missing claim evidence when claim creation loses its pathname", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-claim-missing-"));
    homes.push(home);
    writeBootstrapLock(home, { pid: process.pid + 1_000_000, processStartTime: "1" });
    let claimPath = "";
    let claimWritten = false;
    fsControl.writeHook = (path) => {
      if (path.includes(".lcm-root-bootstrap.lock.reclaim-")) {
        claimPath = path;
        claimWritten = true;
        rmSync(path, { force: true });
      }
    };
    fsControl.statHook = (path, stat) => claimWritten && path === home
      ? Object.assign(stat as object, { ino: (stat as { ino: bigint }).ino + 1n })
      : stat;

    expect(() => bootstrapLcmHome(home)).toThrow("home directory changed during validation");
    expect(claimPath).not.toBe("");
    expect(existsSync(claimPath)).toBe(false);
  });

  it("preserves a recovery claim replaced during exact removal", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-claim-replace-"));
    homes.push(home);
    const stale = writeBootstrapLock(home, { pid: process.pid + 1_000_000, processStartTime: "1" });
    const claimPath = writeBootstrapReclaimClaim(home, stale, {
      pid: process.pid + 1_000_001,
      processStartTime: "1",
    });
    let claimFstats = 0;
    fsControl.fstatHook = (path, stat) => {
      if (path === claimPath && ++claimFstats === 6) {
        rmSync(claimPath, { force: true });
        writeFileSync(claimPath, "replacement claim\n", { mode: 0o600 });
        chmodSync(claimPath, 0o600);
      }
      return stat;
    };

    expect(() => bootstrapLcmHome(home)).toThrow("bootstrap reclaim claim");
    expect(readFileSync(claimPath, "utf8")).toBe("replacement claim\n");
    expect(existsSync(join(home, ".lcm-root-bootstrap.lock"))).toBe(true);
  });

  it("preserves a replacement recreated after a recovery claim unlink", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-claim-unlink-race-"));
    homes.push(home);
    const stale = writeBootstrapLock(home, { pid: process.pid + 1_000_000, processStartTime: "1" });
    const claimPath = writeBootstrapReclaimClaim(home, stale, {
      pid: process.pid + 1_000_001,
      processStartTime: "1",
    });
    let replaced = false;
    fsControl.unlinkHook = (path) => {
      if (!replaced && path === claimPath) {
        replaced = true;
        writeFileSync(claimPath, "replacement claim\n", { mode: 0o600 });
        chmodSync(claimPath, 0o600);
      }
    };

    expect(() => bootstrapLcmHome(home)).toThrow("bootstrap reclaim claim");
    expect(readFileSync(claimPath, "utf8")).toBe("replacement claim\n");
  });

  it("rejects a concurrent successor after stale-lock removal", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-successor-race-"));
    homes.push(home);
    writeBootstrapLock(home, { pid: process.pid + 1_000_000, processStartTime: "1" });
    const competitor = `${JSON.stringify({
      version: 1,
      pid: process.pid,
      processStartTime: processStartTime(),
      nonce: "fedcba9876543210fedcba9876543210",
    })}\n`;
    fsControl.unlinkHook = (path) => {
      if (path === join(home, ".lcm-root-bootstrap.lock")) {
        writeFileSync(path, competitor, { mode: 0o600 });
        chmodSync(path, 0o600);
      }
    };

    expect(() => bootstrapLcmHome(home)).toThrow("claimed concurrently");
    expect(readFileSync(join(home, ".lcm-root-bootstrap.lock"), "utf8")).toBe(competitor);
  });

  it("preserves the claim when successor publication fails and claim cleanup is ambiguous", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-successor-failure-"));
    homes.push(home);
    writeBootstrapLock(home, { pid: process.pid + 1_000_000, processStartTime: "1" });
    const claimPath = `${join(home, ".lcm-root-bootstrap.lock")}.reclaim-0123456789abcdef0123456789abcdef`;
    fsControl.unlinkHook = (path) => {
      if (path === join(home, ".lcm-root-bootstrap.lock")) {
        fsControl.openErrorPath = path;
        fsControl.openErrorPattern = ".reclaim-";
      }
    };

    expect(() => bootstrapLcmHome(home)).toThrow("synthetic open failure");
    expect(existsSync(claimPath)).toBe(true);
    expect(existsSync(join(home, ".lcm-root-bootstrap.lock"))).toBe(false);
  });

  it("continues with a published successor when claim cleanup is ambiguous", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-claim-published-"));
    homes.push(home);
    writeBootstrapLock(home, { pid: process.pid + 1_000_000, processStartTime: "1" });
    const claimPath = `${join(home, ".lcm-root-bootstrap.lock")}.reclaim-0123456789abcdef0123456789abcdef`;
    fsControl.unlinkHook = (path) => {
      if (path === join(home, ".lcm-root-bootstrap.lock")) {
        fsControl.openErrorPattern = ".reclaim-";
      }
    };

    expect(bootstrapLcmHome(home)).toMatchObject({ created: true, migrated: false });
    expect(existsSync(join(home, ".lcm-root-bootstrap.lock"))).toBe(false);
    expect(existsSync(claimPath)).toBe(true);
  });

  it("preserves a replacement between stale authentication and successor claim", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-replacement-"));
    homes.push(home);
    const lockPath = join(home, ".lcm-root-bootstrap.lock");
    writeBootstrapLock(home, { pid: process.pid + 1_000_000, processStartTime: "1" });
    const replacement = `${JSON.stringify({
      version: 1,
      pid: process.pid,
      processStartTime: processStartTime(),
      nonce: "fedcba9876543210fedcba9876543210",
    })}\n`;
    let replaced = false;
    fsControl.writeHook = (path) => {
      if (!replaced && path.includes(".lcm-root-bootstrap.lock.reclaim-")) {
        replaced = true;
        rmSync(lockPath, { force: true });
        writeFileSync(lockPath, replacement, { mode: 0o600 });
        chmodSync(lockPath, 0o600);
      }
    };

    expect(() => bootstrapLcmHome(home)).toThrow("changed during stale-owner recovery");
    expect(readFileSync(lockPath, "utf8")).toBe(replacement);
    expect(readdirSync(home).some((entry) => entry.includes(".reclaim-"))).toBe(false);
  });

  it("serializes two stale-lock contenders through one live reclaim claim", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-contenders-"));
    homes.push(home);
    writeBootstrapLock(home, { pid: process.pid + 1_000_000, processStartTime: "1" });
    let contenderError: unknown;
    let entered = false;
    fsControl.writeHook = (path) => {
      if (!entered && path.includes(".lcm-root-bootstrap.lock.reclaim-")) {
        entered = true;
        try {
          bootstrapLcmHome(home);
        } catch (error) {
          contenderError = error;
        }
      }
    };

    expect(bootstrapLcmHome(home)).toMatchObject({ created: true, migrated: false });
    expect(contenderError).toMatchObject({ message: expect.stringContaining("recovery is already in progress") });
    expect(existsSync(join(home, ".lcm-root-bootstrap.lock"))).toBe(false);
  });

  it("fails closed when the bootstrap lock changes before release", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-replace-"));
    homes.push(home);
    let replaced = false;
    fsControl.writeHook = (path) => {
      if (!replaced && path.endsWith(".lcm-root-bootstrap.lock")) {
        replaced = true;
        rmSync(path, { force: true });
        writeFileSync(path, "replacement\n", { mode: 0o600 });
      }
    };

    expect(() => bootstrapLcmHome(home)).toThrow("bootstrap lock changed before release");
  });

  it("removes an owned bootstrap lock when topology validation fails after writing", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-cleanup-"));
    homes.push(home);
    let armed = false;
    fsControl.writeHook = (path) => {
      if (path.endsWith(".lcm-root-bootstrap.lock")) armed = true;
    };
    fsControl.statHook = (path, stat) => {
      if (armed && path === home) {
        armed = false;
        return Object.assign(stat as object, { ino: (stat as { ino: bigint }).ino + 1n });
      }
      return stat;
    };

    expect(() => bootstrapLcmHome(home)).toThrow("home directory changed during validation");
    expect(existsSync(join(home, ".lcm-root-bootstrap.lock"))).toBe(false);
  });

  it("preserves an unexpected bootstrap-lock replacement during cleanup", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-runtime-lock-replaced-cleanup-"));
    homes.push(home);
    let lockWritten = false;
    fsControl.writeHook = (path) => {
      if (path.endsWith(".lcm-root-bootstrap.lock")) lockWritten = true;
    };
    fsControl.lstatHook = (path, stat) => path.endsWith(".lcm-root-bootstrap.lock") && lockWritten
      ? Object.assign(stat as object, { ino: (stat as { ino: bigint }).ino + 1n })
      : stat;
    fsControl.statHook = (path, stat) => path === home && lockWritten
      ? Object.assign(stat as object, { ino: (stat as { ino: bigint }).ino + 1n })
      : stat;

    expect(() => bootstrapLcmHome(home)).toThrow("home directory changed during validation");
    expect(existsSync(join(home, ".lcm-root-bootstrap.lock"))).toBe(true);
  });

  it("retains the source when the migration journal link loses its race", () => {
    const paths = legacyHome();
    fsControl.linkError = Object.assign(new Error("journal exists"), { code: "EEXIST" });

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("journal already exists");
    expect(existsSync(paths.legacy)).toBe(true);
  });

  it("propagates a non-race migration journal link failure", () => {
    const paths = legacyHome();
    fsControl.linkError = Object.assign(new Error("journal link denied"), { code: "EACCES" });

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("journal link denied");
    expect(existsSync(paths.legacy)).toBe(true);
  });

  it("revalidates after a post-rename publication-lock competitor", () => {
    const paths = legacyHome();
    renameControl.afterActiveRootAppears = () => {
      withBackendPublicationConsumerLock(paths.home, () => {
        // The competitor acquires the newly available consumer lock before
        // migration can advance its journal or remove the legacy source.
        writeFileSync(join(paths.next, "post-rename-competitor"), "changed", { mode: 0o600 });
      });
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("active migration target");
    expect(existsSync(paths.legacy)).toBe(true);
    expect(readFileSync(join(paths.legacy, "value.txt"), "utf-8")).toBe("value");
    expect(readFileSync(join(paths.next, "post-rename-competitor"), "utf-8")).toBe("changed");
  });

  it("rejects an entry whose descriptor changes before validation", () => {
    const paths = legacyHome();
    const valuePath = join(paths.legacy, "value.txt");
    let calls = 0;
    fsControl.fstatHook = (path, stat) => {
      if (descriptorPathTargets(path, valuePath) && calls++ === 0) {
        return { ...(stat as object), ino: (stat as { ino: bigint }).ino + 1n };
      }
      return stat;
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("entry changed before descriptor validation");
  });

  it("rejects an entry whose pathname type differs from its opened descriptor", () => {
    const paths = legacyHome();
    const valuePath = join(paths.legacy, "value.txt");
    fsControl.lstatHook = (path, stat) => {
      if (!descriptorPathTargets(path, valuePath)) return stat;
      return new Proxy(stat as object, {
        get(target, property, receiver) {
          if (property === "isDirectory") return () => true;
          if (property === "isFile") return () => false;
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("entry changed before descriptor validation");
  });

  it("rejects an entry whose descriptor changes after validation", () => {
    const paths = legacyHome();
    const valuePath = join(paths.legacy, "value.txt");
    let calls = 0;
    fsControl.fstatHook = (path, stat) => {
      if (descriptorPathTargets(path, valuePath) && calls++ === 1) {
        return { ...(stat as object), mtimeNs: (stat as { mtimeNs: bigint }).mtimeNs + 1n };
      }
      return stat;
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("legacy migration descriptor changed");
  });

  it("rejects an invalid directory entry name during witness construction", () => {
    const paths = legacyHome();
    fsControl.readdirHook = (path, options) => {
      if (descriptorPathTargets(path, paths.legacy) && (options as { withFileTypes?: boolean } | undefined)?.withFileTypes) {
        return [{ name: "." }];
      }
      return undefined;
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("invalid entry name");
  });

  it("rejects directory entries that change during witness construction", () => {
    const paths = legacyHome();
    let mutated = false;
    fsControl.readdirHook = (path, options, entries) => {
      if (!mutated && descriptorPathTargets(path, paths.legacy) && options === undefined) {
        mutated = true;
        return [...(entries as string[]), "appeared-after-validation"];
      }
      return entries;
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("directory entries changed during validation");
  });

  it("rejects a legacy file over the per-file migration limit", () => {
    const paths = legacyHome();
    writeFileSync(join(paths.legacy, "value.txt"), Buffer.alloc(4 * 1024 * 1024 + 1));

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("file exceeds its size limit");
  });

  it("rejects a legacy tree over the aggregate migration byte limit", () => {
    const paths = legacyHome();
    const payload = Buffer.alloc(4 * 1024 * 1024);
    for (let index = 0; index < 9; index += 1) {
      writeFileSync(join(paths.legacy, `large-${index}.bin`), payload);
    }

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("exceeds its byte limit");
  });

  it("rejects a legacy tree deeper than the authenticated limit", () => {
    const paths = legacyHome();
    let current = paths.legacy;
    for (let depth = 0; depth < 33; depth += 1) {
      current = join(current, `level-${depth}`);
      mkdirSync(current, { mode: 0o700 });
    }

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("tree is too deep");
  });

  it("rejects an unsupported legacy entry during witness construction", () => {
    const paths = legacyHome();
    const result = spawnSync("mkfifo", [join(paths.legacy, "unsupported-pipe")], { encoding: "utf-8" });
    if (result.status !== 0) throw new Error(`mkfifo failed: ${result.stderr}`);

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("unsupported legacy entry type");
  });

  it("rejects a source that becomes over-depth at the copy boundary", () => {
    const paths = legacyHome();
    let injected = false;
    fsControl.writeHook = (_path, _fd, content) => {
      if (!injected && content.toString().includes('"phase":"copying"')) {
        injected = true;
        let current = paths.legacy;
        for (let depth = 0; depth < 33; depth += 1) {
          current = join(current, `late-level-${depth}`);
          mkdirSync(current, { mode: 0o700 });
        }
      }
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("tree is too deep");
  });

  it("rejects a legacy tree with too many authenticated entries", () => {
    const paths = legacyHome();
    for (let index = 0; index < 8191; index += 1) {
      writeFileSync(join(paths.legacy, `entry-${index}`), "x", { mode: 0o600 });
    }

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("too many entries");
  });

  it("rejects a source that changes before the copy descriptor is trusted", () => {
    const paths = legacyHome();
    const valuePath = join(paths.legacy, "value.txt");
    let calls = 0;
    fsControl.fstatHook = (path, stat) => {
      if (descriptorPathTargets(path, valuePath) && calls++ === 4) {
        return { ...(stat as object), ino: (stat as { ino: bigint }).ino + 1n };
      }
      return stat;
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(/source changed before copy|source changed before descriptor validation/);
  });

  it("rejects a source directory that changes before the copy walk", () => {
    const paths = legacyHome();
    let calls = 0;
    fsControl.fstatHook = (path, stat) => {
      if (descriptorPathTargets(path, paths.legacy) && calls++ === 4) {
        return { ...(stat as object), ino: (stat as { ino: bigint }).ino + 1n };
      }
      return stat;
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(/directory changed before copy|source changed before descriptor validation/);
  });

  it("rejects a target conflict during the copy walk", () => {
    const paths = legacyHome();
    fsControl.mkdirHook = (path) => {
      if (path.endsWith(".partial")) writeFileSync(join(path, "value.txt"), "conflict", { mode: 0o600 });
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("target conflicts with source");
  });

  it("rejects a copied staging tree with an extra entry", () => {
    const paths = legacyHome();
    fsControl.mkdirHook = (path) => {
      if (path.endsWith(".partial")) writeFileSync(join(path, "extra.txt"), "extra", { mode: 0o600 });
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("copy does not match source");
  });

  it("rejects a staging witness changed after the copy hash", () => {
    const paths = legacyHome();
    let tampered = false;
    fsControl.fchmodHook = (path) => {
      if (!tampered && path.endsWith(".partial")) {
        tampered = true;
        writeFileSync(join(path, "tamper.txt"), "tamper", { mode: 0o600 });
      }
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("staging witness does not match source");
  });

  it("rejects a copied directory whose names change after the copy", () => {
    const paths = legacyHome();
    let noOptionReads = 0;
    fsControl.readdirHook = (path, options, entries) => {
      if (descriptorPathTargets(path, paths.legacy) && options === undefined && ++noOptionReads === 3) {
        return [...(entries as string[]), "appeared-after-copy"];
      }
      return entries;
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("directory entries changed after copy");
  });

  it("cleans operation-owned staging after a publication rename failure", () => {
    const paths = legacyHome();
    renameControl.error = Object.assign(new Error("publish denied"), { code: "EACCES" });
    renameControl.errorPredicate = (_from, to) => to === paths.next;
    renameControl.errorOnce = true;

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("publish denied");
    expect(existsSync(paths.legacy)).toBe(true);
    expect(existsSync(join(paths.home, ".lcm-legacy-migration.json"))).toBe(true);
  });

  it("preserves temporary-journal evidence when cleanup itself is ambiguous", () => {
    const paths = legacyHome();
    fsControl.linkError = Object.assign(new Error("journal link denied"), { code: "EACCES" });
    fsControl.lstatErrorPattern = ".lcm-legacy-migration.json.";

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("journal link denied");
  });

  it("handles a journal already removed before terminal cleanup", () => {
    const paths = legacyHome();
    fsControl.writeHook = (_path, _fd, content) => {
      if (content.toString().includes('"phase":"published"')) rmSync(paths.legacy, { recursive: true, force: true });
    };
    fsControl.renameHook = (_from, to) => {
      if (to.endsWith(".lcm-legacy-migration.json")) {
        rmSync(to, { force: true });
        fsControl.renameHook = undefined;
      }
    };

    expect(migrateLegacyHomeIfNeeded(paths.home)).toMatchObject({ migrated: true, to: paths.next });
    expect(existsSync(join(paths.home, ".lcm-legacy-migration.json"))).toBe(false);
  });

  it("rejects a non-regular journal during terminal cleanup", () => {
    const paths = legacyHome();
    let published = false;
    fsControl.writeHook = (_path, _fd, content) => {
      if (content.toString().includes('"phase":"published"')) {
        published = true;
        rmSync(paths.legacy, { recursive: true, force: true });
      }
    };
    fsControl.renameHook = (_from, to) => {
      if (published && to.endsWith(".lcm-legacy-migration.json")) {
        rmSync(to, { force: true });
        mkdirSync(to, { mode: 0o700 });
        fsControl.renameHook = undefined;
      }
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("journal is not a regular file");
  });

  it("rejects a copying journal whose staging witness changes at publication", () => {
    const paths = legacyHome();
    const staging = join(paths.home, ".lcm-legacy-migration-"
      + createHash("sha256").update(`.lcm\0${"0123456789abcdef0123456789abcdef0123456789abcdef"}`).digest("hex")
      + ".partial");
    mkdirSync(staging, { mode: 0o700 });
    writeFileSync(join(staging, "value.txt"), "value");
    copyingJournal(paths.home, paths.legacy, staging);
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    renameControl.errorPredicate = (_from, to) => to === paths.next;
    renameControl.errorOnce = true;
    renameControl.beforeError = (from, to) => {
      if (to === paths.next) {
        renameSync(from, `${from}.replaced`);
        mkdirSync(from, { mode: 0o700 });
      }
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("staging witness changed at publish");
  });

  it("rejects a source root that changes before retained evidence copy", () => {
    const paths = legacyHome();
    let armed = false;
    fsControl.writeHook = (_path, _fd, content) => {
      if (armForRetaining(content)) armed = true;
    };
    fsControl.lstatHook = (path, stat) => {
      if (armed && descriptorPathTargets(path, paths.legacy)) {
        armed = false;
        return Object.assign(stat as object, { ino: (stat as { ino: bigint }).ino + 1n });
      }
      return stat;
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(/source changed|descriptor validation|path changed/);
  });

  it("rejects retained evidence whose full witness changes without changing its inode", () => {
    const paths = legacyHome();
    let published = false;
    let sourceRootFstats = 0;
    fsControl.writeHook = (_path, _fd, content) => {
      if (content.toString().includes('"phase":"published"')) published = true;
    };
    fsControl.fstatHook = (path, stat) => {
      if (published && descriptorPathTargets(path, paths.legacy) && ++sourceRootFstats === 3) {
        writeFileSync(join(paths.legacy, "value.txt"), "changed-with-same-inode", { mode: 0o600 });
      }
      return stat;
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(/source changed|retained evidence changed/);
    expect(readFileSync(join(paths.legacy, "value.txt"), "utf-8")).toBe("changed-with-same-inode");
  });

  it("rejects a retaining root replaced after its journal witness is durable", () => {
    const paths = legacyHome();
    let replaced = false;
    fsControl.writeHook = (_path, _fd, content) => {
      if (replaced || !content.toString().includes('"phase":"retaining"')) return;
      const journal = JSON.parse(content.toString()) as { stagingName: string };
      const retained = join(paths.home, journal.stagingName);
      renameSync(retained, `${retained}.replaced`);
      mkdirSync(retained, { mode: 0o700 });
      replaced = true;
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("retaining root changed");
  });

  it("rejects an unrecorded retained root owned by an unexpected user", () => {
    const paths = legacyHome();
    mkdirSync(paths.next, { mode: 0o700 });
    writeFileSync(join(paths.next, "value.txt"), "value", { mode: 0o600 });
    const staging = join(paths.home, ".lcm-legacy-migration-"
      + createHash("sha256").update(`.lcm\0${"0123456789abcdef0123456789abcdef0123456789abcdef"}`).digest("hex")
      + ".partial");
    mkdirSync(staging, { mode: 0o700 });
    retainedJournal(paths.home, paths.legacy, paths.next, staging, "published", null);
    const unexpectedUid = BigInt((typeof process.getuid === "function" ? process.getuid() : 0) + 1);
    const withUnexpectedUid = (path: string, stat: unknown): unknown => descriptorPathTargets(path, staging)
      ? Object.assign(stat as object, { uid: unexpectedUid })
      : stat;
    fsControl.fstatHook = withUnexpectedUid;
    fsControl.lstatHook = withUnexpectedUid;

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("retained evidence path is not an empty private directory");
  });

  it("rejects a source root whose retained-copy descriptor changes", () => {
    const paths = legacyHome();
    let armed = false;
    fsControl.writeHook = (_path, _fd, content) => {
      if (armForRetaining(content)) armed = true;
    };
    fsControl.fstatHook = (path, stat) => {
      if (armed && descriptorPathTargets(path, paths.legacy)) {
        armed = false;
        return { ...(stat as object), ino: (stat as { ino: bigint }).ino + 1n };
      }
      return stat;
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(/source changed|descriptor validation/);
  });

  it("rejects a source file whose retained-copy descriptor changes", () => {
    const paths = legacyHome();
    const valuePath = join(paths.legacy, "value.txt");
    let armed = false;
    fsControl.writeHook = (_path, _fd, content) => {
      if (armForRetaining(content)) armed = true;
    };
    fsControl.fstatHook = (path, stat) => {
      if (armed && descriptorPathTargets(path, valuePath)) {
        armed = false;
        return { ...(stat as object), ino: (stat as { ino: bigint }).ino + 1n };
      }
      return stat;
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(/source changed|descriptor validation/);
  });

  it("rejects a source file that changes during retained evidence copy", () => {
    const paths = legacyHome();
    const valuePath = join(paths.legacy, "value.txt");
    let armed = false;
    let childLstats = 0;
    fsControl.writeHook = (_path, _fd, content) => {
      if (armForRetaining(content)) armed = true;
    };
    fsControl.lstatHook = (path, stat) => {
      if (armed && descriptorPathTargets(path, valuePath) && ++childLstats === 2) {
        armed = false;
        return { ...(stat as object), ino: (stat as { ino: bigint }).ino + 1n };
      }
      return stat;
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(/source changed|path changed during migration|descriptor validation/);
  });

  it("rejects a symlink that appears during retained evidence copy", () => {
    const paths = legacyHome();
    let armed = false;
    fsControl.writeHook = (_path, _fd, content) => {
      if (armForRetaining(content)) armed = true;
    };
    fsControl.readdirHook = (path, options, entries) => {
      if (armed && descriptorPathTargets(path, paths.legacy) && (options as { withFileTypes?: boolean } | undefined)?.withFileTypes) {
        armed = false;
        symlinkSync(join(paths.home, "outside"), join(paths.legacy, "0-link"));
        return [...(entries as Array<{ name: string }>), { name: "0-link" }];
      }
      return entries;
    };
    writeFileSync(join(paths.home, "outside"), "outside");

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(/symlink entry appeared|symlink entries are not supported/);
  });

  it("rejects an unsupported entry that appears during retained evidence copy", () => {
    const paths = legacyHome();
    let armed = false;
    fsControl.writeHook = (_path, _fd, content) => {
      if (armForRetaining(content)) armed = true;
    };
    fsControl.readdirHook = (path, options, entries) => {
      if (armed && descriptorPathTargets(path, paths.legacy) && (options as { withFileTypes?: boolean } | undefined)?.withFileTypes) {
        armed = false;
        const result = spawnSync("mkfifo", [join(paths.legacy, "0-pipe")], { encoding: "utf-8" });
        if (result.status !== 0) throw new Error(`mkfifo failed: ${result.stderr}`);
        return [...(entries as Array<{ name: string }>), { name: "0-pipe" }];
      }
      return entries;
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("unsupported legacy entry type");
  });

  it("retains the source without unlinking after terminal evidence validation", () => {
    const paths = legacyHome();
    let armed = false;
    fsControl.writeHook = (_path, _fd, content) => {
      if (content.toString().includes('"phase":"retained"')) armed = true;
    };
    fsControl.unlinkHook = (path) => {
      if (armed && descriptorPathTargets(path, join(paths.legacy, "value.txt"))) {
        armed = false;
        writeFileSync(join(paths.legacy, "late-entry"), "late", { mode: 0o600 });
      }
    };

    expect(migrateLegacyHomeIfNeeded(paths.home)).toMatchObject({ migrated: true, to: paths.next });
    expect(readFileSync(join(paths.legacy, "value.txt"), "utf-8")).toBe("value");
    expect(existsSync(join(paths.home, ".lcm-legacy-migration.json"))).toBe(true);
  });
});
