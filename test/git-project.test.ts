import {
  constants,
  type Dirent,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pathBoundary = vi.hoisted(() => ({
  parseRoot: "",
  parseRootPath: "",
  parseRoots: new Map<string, string>(),
  redirectFrom: "",
  redirectTo: "",
}));

const metadataRace = vi.hoisted((): {
  afterRead: ((path: string) => void) | undefined;
} => ({ afterRead: undefined }));

const caseInsensitivePath = vi.hoisted(() => ({
  from: "",
  realpathReturnsMapped: false,
  realpathTo: "",
  to: "",
  zeroFromField: undefined as "dev" | "ino" | undefined,
  zeroToField: undefined as "dev" | "ino" | undefined,
}));

const componentDirectory = vi.hoisted((): {
  closeCount: number;
  directorySymlinkPath: string;
  entryPath: string;
  entryTarget: string;
  openCount: number;
  options: unknown[];
  path: string;
  plans: Array<{
    closeError?: Error;
    entries?: readonly (Buffer | string)[];
    openError?: Error;
    readErrorAt?: number;
    repeat?: { readonly count: number; readonly name: Buffer | string };
  }>;
  readCount: number;
} => ({
  closeCount: 0,
  directorySymlinkPath: "",
  entryPath: "",
  entryTarget: "",
  openCount: 0,
  options: [],
  path: "",
  plans: [],
  readCount: 0,
}));

const directoryAuthRace = vi.hoisted(() => ({
  afterOpen: undefined as (() => void) | undefined,
  afterRealpath: undefined as (() => void) | undefined,
  afterRealpathAt: 0,
  beforeOpen: undefined as (() => void) | undefined,
  closeCount: 0,
  closeError: undefined as Error | undefined,
  descriptorMismatchAt: 0,
  descriptorMismatchField: "dev" as "dev" | "ino",
  fstatCount: 0,
  fstatError: undefined as Error | undefined,
  invalidDescriptorAt: 0,
  invalidDirectoryAt: 0,
  lstatCount: 0,
  lstatPath: "",
  mismatchedStatAt: 0,
  openCount: 0,
  openError: undefined as Error | undefined,
  openFlags: undefined as number | undefined,
  openPath: "",
  realpathCount: 0,
  statCount: 0,
  statPath: "",
  trackedDescriptors: new Set<number>(),
  unsupportedFlag: undefined as "directory" | "nofollow" | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const mappedPath = <T>(path: T): T => String(path) === caseInsensitivePath.from
    ? caseInsensitivePath.to as T
    : path;
  const mockedConstants = { ...actual.constants };
  Object.defineProperties(mockedConstants, {
    O_DIRECTORY: {
      configurable: true,
      enumerable: true,
      get: () => directoryAuthRace.unsupportedFlag === "directory"
        ? undefined
        : actual.constants.O_DIRECTORY,
    },
    O_NOFOLLOW: {
      configurable: true,
      enumerable: true,
      get: () => directoryAuthRace.unsupportedFlag === "nofollow"
        ? undefined
        : actual.constants.O_NOFOLLOW,
    },
  });
  return {
    ...actual,
    closeSync: ((fd: number) => {
      const tracked = directoryAuthRace.trackedDescriptors.has(fd);
      if (tracked) directoryAuthRace.closeCount += 1;
      actual.closeSync(fd);
      if (tracked) {
        directoryAuthRace.trackedDescriptors.delete(fd);
        if (directoryAuthRace.closeError !== undefined) {
          throw directoryAuthRace.closeError;
        }
      }
    }) as typeof actual.closeSync,
    constants: mockedConstants,
    fstatSync: ((fd: number, options?: Parameters<typeof actual.fstatSync>[1]) => {
      if (!directoryAuthRace.trackedDescriptors.has(fd)) {
        return actual.fstatSync(fd, options as never);
      }
      directoryAuthRace.fstatCount += 1;
      if (directoryAuthRace.fstatError !== undefined) {
        throw directoryAuthRace.fstatError;
      }
      const stat = actual.fstatSync(fd, options as never);
      if (directoryAuthRace.fstatCount === directoryAuthRace.invalidDescriptorAt) {
        const changed = Object.create(stat) as typeof stat;
        changed.isDirectory = (): boolean => false;
        return changed;
      }
      if (directoryAuthRace.fstatCount === directoryAuthRace.descriptorMismatchAt) {
        const changed = Object.create(stat) as typeof stat;
        Object.defineProperty(changed, directoryAuthRace.descriptorMismatchField, {
          value: Number(stat[directoryAuthRace.descriptorMismatchField]) + 1,
        });
        return changed;
      }
      return stat;
    }) as typeof actual.fstatSync,
    lstatSync: ((path: Parameters<typeof actual.lstatSync>[0], options?: Parameters<typeof actual.lstatSync>[1]) => {
      const mapped = String(path) === componentDirectory.entryPath
        ? componentDirectory.entryTarget
        : mappedPath(path);
      const stat = actual.lstatSync(mapped, options as never);
      if (String(path) === componentDirectory.directorySymlinkPath) {
        const changed = Object.create(stat) as typeof stat;
        changed.isDirectory = (): boolean => true;
        changed.isSymbolicLink = (): boolean => true;
        return changed;
      }
      const zeroField = String(path) === caseInsensitivePath.from
        ? caseInsensitivePath.zeroFromField
        : String(path) === caseInsensitivePath.to
          ? caseInsensitivePath.zeroToField
          : undefined;
      if (zeroField !== undefined) {
        const changed = Object.create(stat) as typeof stat;
        Object.defineProperty(changed, zeroField, { value: 0 });
        return changed;
      }
      if (String(path) === directoryAuthRace.lstatPath) {
        directoryAuthRace.lstatCount += 1;
        if (directoryAuthRace.lstatCount === directoryAuthRace.invalidDirectoryAt) {
          const changed = Object.create(stat) as typeof stat;
          changed.isDirectory = (): boolean => false;
          return changed;
        }
      }
      return stat;
    }) as typeof actual.lstatSync,
    openSync: ((
      path: Parameters<typeof actual.openSync>[0],
      flags: Parameters<typeof actual.openSync>[1],
      mode?: Parameters<typeof actual.openSync>[2],
    ) => {
      if (String(path) !== directoryAuthRace.openPath) {
        return actual.openSync(mappedPath(path), flags, mode as never);
      }
      directoryAuthRace.openCount += 1;
      directoryAuthRace.openFlags = typeof flags === "number" ? flags : undefined;
      if (directoryAuthRace.openError !== undefined) {
        throw directoryAuthRace.openError;
      }
      directoryAuthRace.beforeOpen?.();
      const fd = actual.openSync(mappedPath(path), flags, mode as never);
      directoryAuthRace.trackedDescriptors.add(fd);
      directoryAuthRace.afterOpen?.();
      return fd;
    }) as typeof actual.openSync,
    opendirSync: ((
      path: Parameters<typeof actual.opendirSync>[0],
      options?: Parameters<typeof actual.opendirSync>[1],
    ) => {
      if (String(path) !== componentDirectory.path) {
        return actual.opendirSync(path, options as never);
      }
      const plan = componentDirectory.plans[componentDirectory.openCount++];
      componentDirectory.options.push(options);
      if (plan?.openError !== undefined) throw plan.openError;
      let index = 0;
      let planReads = 0;
      return {
        readSync: () => {
          componentDirectory.readCount += 1;
          planReads += 1;
          if (planReads === plan?.readErrorAt) {
            throw new Error("synthetic component directory read failure");
          }
          let name: Buffer | string | undefined;
          if (plan?.repeat !== undefined && index < plan.repeat.count) {
            name = plan.repeat.name;
          } else {
            name = plan?.entries?.[index - (plan?.repeat?.count ?? 0)];
          }
          index += 1;
          if (name === undefined) return null;
          return {
            isDirectory: (): boolean => true,
            isSymbolicLink: (): boolean => false,
            name: Buffer.isBuffer(name) ? name : Buffer.from(name),
          } as Dirent<Buffer>;
        },
        closeSync: () => {
          componentDirectory.closeCount += 1;
          if (plan?.closeError !== undefined) throw plan.closeError;
        },
      } as ReturnType<typeof opendirSync>;
    }) as typeof actual.opendirSync,
    realpathSync: ((
      path: Parameters<typeof actual.realpathSync>[0],
      options?: Parameters<typeof actual.realpathSync>[1],
    ) => {
      const real = actual.realpathSync(mappedPath(path), options as never);
      if (String(path) === directoryAuthRace.openPath) {
        directoryAuthRace.realpathCount += 1;
        if (directoryAuthRace.realpathCount === directoryAuthRace.afterRealpathAt) {
          directoryAuthRace.afterRealpath?.();
        }
      }
      if (String(path) !== caseInsensitivePath.from) return real;
      if (!caseInsensitivePath.realpathReturnsMapped) return path;
      return caseInsensitivePath.realpathTo || real;
    }) as typeof actual.realpathSync,
    statSync: ((path: Parameters<typeof actual.statSync>[0], options?: Parameters<typeof actual.statSync>[1]) => {
      const stat = actual.statSync(mappedPath(path), options as never);
      const zeroField = String(path) === caseInsensitivePath.from
        ? caseInsensitivePath.zeroFromField
        : String(path) === caseInsensitivePath.to
          ? caseInsensitivePath.zeroToField
          : undefined;
      if (zeroField !== undefined) {
        const changed = Object.create(stat) as typeof stat;
        Object.defineProperty(changed, zeroField, { value: 0 });
        return changed;
      }
      if (String(path) === directoryAuthRace.statPath) {
        directoryAuthRace.statCount += 1;
        if (directoryAuthRace.statCount === directoryAuthRace.mismatchedStatAt) {
          const changed = Object.create(stat) as typeof stat;
          Object.defineProperty(changed, "dev", { value: Number(stat.dev) + 1 });
          return changed;
        }
      }
      return stat;
    }) as typeof actual.statSync,
  };
});

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    dirname: (path: string): string => path === pathBoundary.redirectFrom
      ? pathBoundary.redirectTo
      : actual.dirname(path),
    parse: (path: string): ReturnType<typeof actual.parse> => {
      const parsed = actual.parse(path);
      const mappedRoot = pathBoundary.parseRoots.get(path);
      if (mappedRoot !== undefined) return { ...parsed, root: mappedRoot };
      return path === pathBoundary.parseRootPath
        ? { ...parsed, root: pathBoundary.parseRoot }
        : parsed;
    },
  };
});

vi.mock("../src/security-files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/security-files.js")>();
  return {
    ...actual,
    readBoundedRegularFile: (path: string, options: Parameters<typeof actual.readBoundedRegularFile>[1]): string => {
      const content = actual.readBoundedRegularFile(path, options);
      metadataRace.afterRead?.(path);
      return content;
    },
  };
});

import {
  clearGitProjectAnchorCache,
  resolveGitProjectAnchor,
} from "../src/git-project.js";

function makeDirectory(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

function makeRepository(root: string): string {
  makeDirectory(join(root, ".git"));
  makeDirectory(join(root, ".git", "objects"));
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, ".git", "config"), "[core]\nrepositoryformatversion = 0\n");
  return root;
}

function padGitConfigToBytes(config: string, targetBytes: number): string {
  const paddingBytes = targetBytes - Buffer.byteLength(config);
  if (paddingBytes < 2) throw new Error("Git config target is too small");
  return `${config}#${"x".repeat(paddingBytes - 2)}\n`;
}

function repeatedBranchMetadataConfig(targetBytes: number): string {
  const prefix = "[core]\nrepositoryformatversion = 0\n[branch \"main\"]\n";
  const entry = "github-pr-owner-number = 123\n";
  const entryCount = Math.floor(
    (targetBytes - Buffer.byteLength(prefix) - 2) / Buffer.byteLength(entry),
  );
  return padGitConfigToBytes(`${prefix}${entry.repeat(entryCount)}`, targetBytes);
}

function makeLinkedWorktree(primary: string, linked: string, name = "linked"): string {
  const gitDir = makeDirectory(join(primary, ".git", "worktrees", name));
  writeFileSync(join(gitDir, "commondir"), "../..\n");
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/linked\n");
  makeDirectory(linked);
  writeFileSync(join(linked, ".git"), `gitdir: ${gitDir}\n`);
  writeFileSync(join(gitDir, "gitdir"), `${join(linked, ".git")}\n`);
  return linked;
}

function makeStandaloneMetadata(
  checkout: string,
  metadata: string,
  config: string,
  absolutePointer = true,
): void {
  makeDirectory(checkout);
  makeDirectory(join(metadata, "objects"));
  writeFileSync(join(metadata, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(metadata, "config"), config);
  writeFileSync(
    join(checkout, ".git"),
    `gitdir: ${absolutePointer ? metadata : relative(checkout, metadata)}\n`,
  );
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function resetDirectoryAuthRace(): void {
  caseInsensitivePath.from = "";
  caseInsensitivePath.realpathReturnsMapped = false;
  caseInsensitivePath.realpathTo = "";
  caseInsensitivePath.to = "";
  caseInsensitivePath.zeroFromField = undefined;
  caseInsensitivePath.zeroToField = undefined;
  componentDirectory.closeCount = 0;
  componentDirectory.directorySymlinkPath = "";
  componentDirectory.entryPath = "";
  componentDirectory.entryTarget = "";
  componentDirectory.openCount = 0;
  componentDirectory.options = [];
  componentDirectory.path = "";
  componentDirectory.plans = [];
  componentDirectory.readCount = 0;
  directoryAuthRace.afterOpen = undefined;
  directoryAuthRace.afterRealpath = undefined;
  directoryAuthRace.afterRealpathAt = 0;
  directoryAuthRace.beforeOpen = undefined;
  directoryAuthRace.closeCount = 0;
  directoryAuthRace.closeError = undefined;
  directoryAuthRace.descriptorMismatchAt = 0;
  directoryAuthRace.descriptorMismatchField = "dev";
  directoryAuthRace.fstatCount = 0;
  directoryAuthRace.fstatError = undefined;
  directoryAuthRace.invalidDescriptorAt = 0;
  directoryAuthRace.invalidDirectoryAt = 0;
  directoryAuthRace.lstatCount = 0;
  directoryAuthRace.lstatPath = "";
  directoryAuthRace.mismatchedStatAt = 0;
  directoryAuthRace.openCount = 0;
  directoryAuthRace.openError = undefined;
  directoryAuthRace.openFlags = undefined;
  directoryAuthRace.openPath = "";
  directoryAuthRace.realpathCount = 0;
  directoryAuthRace.statCount = 0;
  directoryAuthRace.statPath = "";
  directoryAuthRace.trackedDescriptors.clear();
  directoryAuthRace.unsupportedFlag = undefined;
}

describe("Git project identity", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lcm-git-project-"));
    pathBoundary.parseRoot = "";
    pathBoundary.parseRootPath = "";
    pathBoundary.parseRoots.clear();
    pathBoundary.redirectFrom = "";
    pathBoundary.redirectTo = "";
    metadataRace.afterRead = undefined;
    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
  });

  afterEach(() => {
    pathBoundary.parseRoot = "";
    pathBoundary.parseRootPath = "";
    pathBoundary.redirectFrom = "";
    pathBoundary.redirectTo = "";
    metadataRace.afterRead = undefined;
    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    rmSync(root, { recursive: true, force: true });
  });

  it("maps a primary checkout, linked worktree, and nested directory to one anchor", () => {
    const primary = makeRepository(join(root, "primary"));
    const linked = makeLinkedWorktree(primary, join(root, "linked"));
    const nested = makeDirectory(join(linked, "src", "nested"));

    expect(resolveGitProjectAnchor(primary)).toEqual({
      canonical: primary,
      worktreeRoot: primary,
      commonDir: join(primary, ".git"),
    });
    expect(resolveGitProjectAnchor(linked)).toEqual({
      canonical: primary,
      worktreeRoot: linked,
      commonDir: join(primary, ".git"),
    });
    expect(resolveGitProjectAnchor(nested)).toEqual({
      canonical: primary,
      worktreeRoot: linked,
      commonDir: join(primary, ".git"),
    });
    // Exercise the successful cache path.
    expect(resolveGitProjectAnchor(nested)?.canonical).toBe(primary);
  });

  it("keeps separate clones distinct and returns null for non-Git directories", () => {
    const first = makeRepository(join(root, "first"));
    const second = makeRepository(join(root, "second"));
    const plain = makeDirectory(join(root, "plain"));

    expect(resolveGitProjectAnchor(first)?.canonical).toBe(first);
    expect(resolveGitProjectAnchor(second)?.canonical).toBe(second);
    expect(resolveGitProjectAnchor(plain)).toBeNull();
    expect(resolveGitProjectAnchor(plain)).toBeNull();
    makeRepository(plain);
    expect(resolveGitProjectAnchor(plain)?.canonical).toBe(plain);
    expect(resolveGitProjectAnchor(join(root, "missing"))).toBeNull();
  });

  it("anchors a real submodule at its checkout rather than superproject metadata", () => {
    const submoduleSource = join(root, "submodule-source");
    const superproject = join(root, "superproject");
    makeDirectory(submoduleSource);
    git(submoduleSource, "init", "-q");
    git(submoduleSource, "config", "user.email", "test@example.invalid");
    git(submoduleSource, "config", "user.name", "LCM Test");
    writeFileSync(join(submoduleSource, "README.md"), "submodule\n");
    git(submoduleSource, "add", "README.md");
    git(submoduleSource, "commit", "-qm", "initial");
    makeDirectory(superproject);
    git(superproject, "init", "-q");
    git(superproject, "config", "user.email", "test@example.invalid");
    git(superproject, "config", "user.name", "LCM Test");
    writeFileSync(join(superproject, "README.md"), "superproject\n");
    git(superproject, "add", "README.md");
    git(superproject, "commit", "-qm", "initial");
    git(superproject, "-c", "protocol.file.allow=always", "submodule", "add", "../submodule-source", "modules/sub");

    const submodule = join(superproject, "modules", "sub");
    makeDirectory(join(submodule, "nested"));
    const anchor = resolveGitProjectAnchor(join(submodule, "nested"));
    if (!anchor) throw new Error("expected submodule Git project anchor");
    expect(anchor).toMatchObject({ canonical: submodule, worktreeRoot: submodule });
    expect(anchor.commonDir).toContain(join(".git", "modules", "modules", "sub"));
    expect(resolveGitProjectAnchor(superproject)?.canonical).toBe(superproject);

    git(submodule, "config", "--unset", "core.worktree");
    git(submodule, "config", "extensions.worktreeConfig", "true");
    git(submodule, "config", "--worktree", "core.worktree", submodule);
    expect(git(submodule, "config", "--show-origin", "--get", "core.worktree"))
      .toContain("config.worktree");
    expect(git(submodule, "rev-parse", "--show-toplevel")).toBe(submodule);
    clearGitProjectAnchorCache();
    expect(resolveGitProjectAnchor(join(submodule, "nested"))).toMatchObject({
      canonical: submodule,
      worktreeRoot: submodule,
    });

    const commonConfigPath = join(anchor.commonDir, "config");
    const writeWorktreeConfig = (line: string): void => {
      writeFileSync(
        commonConfigPath,
        `[core]\nrepositoryformatversion = 0\n[extensions]\n${line}\n`,
      );
      clearGitProjectAnchorCache();
    };
    const configuredWorktreeBool = (): string => git(
      submodule,
      "config",
      "--file",
      commonConfigPath,
      "--bool",
      "--get",
      "extensions.worktreeConfig",
    );
    const expectSubmoduleAnchor = (): void => {
      expect(resolveGitProjectAnchor(join(submodule, "nested"))).toMatchObject({
        canonical: submodule,
        worktreeRoot: submodule,
      });
    };
    const expectRejectedAnchor = (message: string): void => {
      expect(() => resolveGitProjectAnchor(join(submodule, "nested"))).toThrow(message);
    };

    for (const line of [
      "worktreeConfig = true # enabled",
      "worktreeConfig = true#enabled",
      "worktreeConfig = true ; enabled",
      "worktreeConfig = true;enabled",
      "worktreeConfig",
      "worktreeConfig = yes;enabled",
      "worktreeConfig = on # enabled",
      "worktreeConfig = 1;enabled",
      "worktreeConfig = 2",
      "worktreeConfig = -1",
      "worktreeConfig = 01",
      "worktreeConfig = +1",
      "worktreeConfig = 1k",
      "worktreeConfig = 0x1",
      "worktreeConfig = -1g",
      "worktreeConfig = 2147483647",
      "worktreeConfig = -2147483647",
      "worktreeConfig = -0x7fffffff",
      "worktreeConfig = -017777777777",
      "worktreeConfig = 2097151k",
      "worktreeConfig = -2097151k",
      "worktreeConfig = 2047m",
      "worktreeConfig = -2047m",
      "worktreeConfig = 1G",
      "worktreeConfig = +0Xf",
    ]) {
      writeWorktreeConfig(line);
      expect(configuredWorktreeBool()).toBe("true");
      expectSubmoduleAnchor();
    }

    for (const encodedWhitespace of [
      " ",
      "\\t",
      "\\n",
      "\r",
      "\f",
      "\v",
    ]) {
      writeWorktreeConfig(
        `worktreeConfig = "${encodedWhitespace}+01k"`,
      );
      expect(configuredWorktreeBool()).toBe("true");
      expectSubmoduleAnchor();
    }

    for (const line of [
      "worktreeConfig = false # disabled",
      "worktreeConfig = no;disabled",
      "worktreeConfig = off;disabled",
      "worktreeConfig = 0 # disabled",
      "worktreeConfig =",
      "worktreeConfig = -0",
      "worktreeConfig = +0",
      "worktreeConfig = 00",
      "worktreeConfig = 0k",
      "worktreeConfig = 00M",
    ]) {
      writeWorktreeConfig(line);
      expect(configuredWorktreeBool()).toBe("false");
      expectRejectedAnchor("expected one core.worktree path");
    }

    for (const [config, expected] of [
      [
        [
          "[core]",
          "repositoryformatversion = 0",
          "[extensions]",
          "worktreeConfig = true # superseded",
          "worktreeConfig = false;final",
          "",
        ].join("\n"),
        false,
      ],
      [
        [
          "[extensions]",
          "worktreeConfig = 0",
          "[core]",
          "repositoryformatversion = 0",
          "[extensions]",
          "worktreeConfig",
          "",
        ].join("\n"),
        true,
      ],
      [
        [
          "[extensions]",
          "worktreeConfig = no",
          "[extensions]",
          "worktreeConfig = yes;superseded",
          "[extensions]",
          "worktreeConfig = off # final",
          "",
        ].join("\n"),
        false,
      ],
      [
        [
          "[extensions]",
          "worktreeConfig = 00M",
          "worktreeConfig = 0x1",
          "",
        ].join("\n"),
        true,
      ],
      [
        [
          "[extensions]",
          "worktreeConfig = -1",
          "worktreeConfig = +0",
          "",
        ].join("\n"),
        false,
      ],
    ] as const) {
      writeFileSync(commonConfigPath, config);
      clearGitProjectAnchorCache();
      expect(configuredWorktreeBool()).toBe(expected ? "true" : "false");
      if (expected) expectSubmoduleAnchor();
      else expectRejectedAnchor("expected one core.worktree path");
    }

    for (const line of [
      "worktreeConfig = true trailing",
      "worktreeConfig # enabled",
    ]) {
      writeWorktreeConfig(line);
      expect(configuredWorktreeBool).toThrow();
      expectRejectedAnchor("ambiguous worktree configuration");
    }

    // Git 2.43 rejects INT_MIN and scaled forms that reach it, while newer
    // Git releases accept them. LCM uses the portable cross-version range, so
    // these assertions intentionally do not use the host Git binary as oracle.
    for (const value of [
      "-2147483648",
      "-0x80000000",
      "-020000000000",
      "-2097152k",
      "-2048m",
      "-2g",
    ]) {
      writeWorktreeConfig(`worktreeConfig = ${value}`);
      expectRejectedAnchor("ambiguous worktree configuration");
    }

    for (const value of [
      "maybe",
      "+",
      "--1",
      "08",
      "0x",
      "0b2",
      "1t",
      "2147483648",
      "-2147483649",
      "2097152k",
      "2048m",
      "2g",
    ]) {
      writeWorktreeConfig(`worktreeConfig = ${value}`);
      expect(configuredWorktreeBool).toThrow();
      expectRejectedAnchor("ambiguous worktree configuration");
    }

    for (const line of [
      `worktreeConfig = " ${"\\t"}${"\\n"}\r\f\v"`,
      'worktreeConfig = " true"',
      'worktreeConfig = "1 "',
      'worktreeConfig = "1 0"',
    ]) {
      writeWorktreeConfig(line);
      expect(configuredWorktreeBool).toThrow();
      expectRejectedAnchor("ambiguous worktree configuration");
    }

    writeWorktreeConfig('worktreeConfig = "\u00a0+1"');
    expectRejectedAnchor("ambiguous worktree configuration");

    for (const value of ["0b1", "0B0"]) {
      writeWorktreeConfig(`worktreeConfig = ${value}`);
      // Git delegates base-0 parsing to the host C library, so C23 binary
      // prefixes are not portable. LCM rejects them regardless of host Git.
      expectRejectedAnchor("ambiguous worktree configuration");
    }

    writeFileSync(
      commonConfigPath,
      [
        "[extensions]",
        "worktreeConfig = true",
        "worktreeConfig = unsupported",
        "[extensions]",
        "worktreeConfig = true",
        "",
      ].join("\n"),
    );
    clearGitProjectAnchorCache();
    expect(configuredWorktreeBool).toThrow();
    expectRejectedAnchor("ambiguous worktree configuration");
  });

  it("revalidates cached anchors when nearer or changed Git metadata appears", () => {
    const primary = makeRepository(join(root, "primary"));
    const linked = makeLinkedWorktree(primary, join(root, "linked"));
    const nested = makeDirectory(join(linked, "nested"));

    expect(resolveGitProjectAnchor(nested)?.canonical).toBe(primary);

    const nestedRepository = makeRepository(nested);
    expect(resolveGitProjectAnchor(nested)?.canonical).toBe(nestedRepository);

    rmSync(join(nested, ".git"), { recursive: true });
    expect(resolveGitProjectAnchor(nested)?.canonical).toBe(primary);

    const replacement = makeRepository(join(root, "replacement"));
    const replacementWorktree = makeLinkedWorktree(
      replacement,
      join(root, "replacement-linked"),
      "replacement-linked",
    );
    writeFileSync(
      join(linked, ".git"),
      `gitdir: ${join(replacement, ".git", "worktrees", "replacement-linked")}\n`,
    );
    expect(() => resolveGitProjectAnchor(nested)).toThrow(
      "topology does not point",
    );
    writeFileSync(
      join(replacement, ".git", "worktrees", "replacement-linked", "gitdir"),
      `${join(linked, ".git")}\n`,
    );
    expect(resolveGitProjectAnchor(nested)).toEqual({
      canonical: replacement,
      worktreeRoot: linked,
      commonDir: join(replacement, ".git"),
    });

    rmSync(join(linked, ".git"));
    expect(resolveGitProjectAnchor(nested)).toBeNull();
    writeFileSync(
      join(replacement, ".git", "worktrees", "replacement-linked", "gitdir"),
      `${join(replacementWorktree, ".git")}\n`,
    );
    expect(resolveGitProjectAnchor(replacementWorktree)?.canonical).toBe(replacement);
  });

  it("terminates cached-anchor revalidation when the cached root is no longer an ancestor", () => {
    const primary = makeRepository(join(root, "primary"));
    const nested = makeDirectory(join(primary, "nested"));
    expect(resolveGitProjectAnchor(nested)?.canonical).toBe(primary);

    rmSync(join(primary, ".git"), { recursive: true });
    pathBoundary.redirectFrom = nested;
    pathBoundary.redirectTo = makeDirectory(join(root, "unrelated"));

    expect(resolveGitProjectAnchor(nested)).toBeNull();
  });

  it("uses an unusual shared Git directory itself as the stable anchor", () => {
    const shared = makeDirectory(join(root, "shared.git"));
    makeDirectory(join(shared, "objects"));
    writeFileSync(join(shared, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(shared, "config"), "[core]\nrepositoryformatversion = 0\n");
    const gitDir = makeDirectory(join(shared, "worktrees", "one"));
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/one\n");
    const linked = makeDirectory(join(root, "linked"));
    writeFileSync(join(linked, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "gitdir"), `${join(linked, ".git")}\n`);

    expect(resolveGitProjectAnchor(linked)).toEqual({
      canonical: shared,
      worktreeRoot: linked,
      commonDir: shared,
    });

    const externalCheckout = makeDirectory(join(root, "external-checkout"));
    writeFileSync(
      join(shared, "config"),
      `[core]\nrepositoryformatversion = 0\nworktree = ${externalCheckout}\n`,
    );
    writeFileSync(join(externalCheckout, ".git"), `gitdir: ${shared}\n`);
    expect(resolveGitProjectAnchor(externalCheckout)).toEqual({
      canonical: shared,
      worktreeRoot: externalCheckout,
      commonDir: shared,
    });

    writeFileSync(
      join(shared, "config"),
      `[core]\nrepositoryformatversion = 0\nworktree = ${externalCheckout}\n[extensions]\nworktreeConfig = true\n`,
    );
    clearGitProjectAnchorCache();
    expect(resolveGitProjectAnchor(externalCheckout)?.canonical).toBe(shared);
  });

  it("uses one external anchor for a separate-git-dir primary and its linked worktree", () => {
    const primary = makeDirectory(join(root, "separate-primary"));
    const shared = join(root, "separate-metadata");
    git(root, "init", "-q", "--separate-git-dir", shared, primary);
    git(primary, "config", "user.email", "test@example.invalid");
    git(primary, "config", "user.name", "LCM Test");
    git(primary, "config", "core.worktree", primary);
    writeFileSync(join(primary, "README.md"), "separate metadata\n");
    git(primary, "add", "README.md");
    git(primary, "commit", "-qm", "initial");
    const linked = join(root, "separate-linked");
    git(primary, "worktree", "add", "-q", "-b", "separate-linked", linked);
    expect(git(primary, "rev-parse", "--show-toplevel")).toBe(primary);
    expect(git(linked, "rev-parse", "--show-toplevel")).toBe(linked);

    expect(resolveGitProjectAnchor(primary)).toEqual({
      canonical: shared,
      worktreeRoot: primary,
      commonDir: shared,
    });
    expect(resolveGitProjectAnchor(linked)).toEqual({
      canonical: shared,
      worktreeRoot: linked,
      commonDir: shared,
    });

    git(primary, "config", "extensions.worktreeConfig", "true");
    clearGitProjectAnchorCache();
    expect(resolveGitProjectAnchor(primary)?.canonical).toBe(shared);
  });

  it("requires an exact final core.worktree backlink for standalone external metadata", () => {
    const checkout = join(root, "verified#checkout");
    const metadata = join(root, "verified-metadata");
    makeStandaloneMetadata(
      checkout,
      metadata,
      [
        "\uFEFF[core]",
        "worktree = ../wrong",
        'worktree = "../verified#checkout" # final quoted backlink',
        "[extensions]",
        "worktreeConfig = true",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(metadata, "config.worktree"),
      '\uFEFF[core]\r\nworktree = ../wrong\r\nworktree = "../verified#checkout" ; final\r\n',
    );
    expect(git(
      root,
      "config",
      "--file",
      join(metadata, "config"),
      "--get",
      "core.worktree",
    )).toBe("../verified#checkout");
    expect(git(
      root,
      "config",
      "--file",
      join(metadata, "config.worktree"),
      "--get",
      "core.worktree",
    )).toBe("../verified#checkout");
    expect(resolveGitProjectAnchor(checkout)).toEqual({
      canonical: metadata,
      worktreeRoot: checkout,
      commonDir: metadata,
    });

    for (const [name, unsupportedFlag] of [
      ["descriptor", undefined],
      ["fallback", "directory"],
    ] as const) {
      resetDirectoryAuthRace();
      clearGitProjectAnchorCache();
      const caseCheckout = join(root, `${name}-case-checkout`);
      const differentlyCasedCheckout = join(root, `${name}-CASE-CHECKOUT`);
      const caseMetadata = join(root, `${name}-case-metadata`);
      makeStandaloneMetadata(
        caseCheckout,
        caseMetadata,
        `[core]\nworktree = ${differentlyCasedCheckout}\n`,
      );
      caseInsensitivePath.from = differentlyCasedCheckout;
      caseInsensitivePath.to = caseCheckout;
      directoryAuthRace.unsupportedFlag = unsupportedFlag;
      expect(resolveGitProjectAnchor(caseCheckout)).toEqual({
        canonical: caseMetadata,
        worktreeRoot: caseCheckout,
        commonDir: caseMetadata,
      });
    }

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const intermediateCheckout = join(
      root,
      "Intermediate-Parent",
      "case-checkout",
    );
    const differentlyCasedIntermediate = join(
      root,
      "intermediate-parent",
      "CASE-CHECKOUT",
    );
    const intermediateMetadata = join(root, "intermediate-case-metadata");
    makeStandaloneMetadata(
      intermediateCheckout,
      intermediateMetadata,
      `[core]\nworktree = ${differentlyCasedIntermediate}\n`,
    );
    caseInsensitivePath.from = differentlyCasedIntermediate;
    caseInsensitivePath.to = intermediateCheckout;
    expect(resolveGitProjectAnchor(intermediateCheckout)?.canonical).toBe(
      intermediateMetadata,
    );

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const aliasCheckout = join(root, "same-identity-checkout");
    const arbitraryAlias = join(root, "arbitrary-alias");
    const aliasMetadata = join(root, "same-identity-metadata");
    makeStandaloneMetadata(
      aliasCheckout,
      aliasMetadata,
      `[core]\nworktree = ${arbitraryAlias}\n`,
    );
    caseInsensitivePath.from = arbitraryAlias;
    caseInsensitivePath.to = aliasCheckout;
    expect(() => resolveGitProjectAnchor(aliasCheckout)).toThrow(
      "topology does not point",
    );

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const unavailableCheckout = join(root, "unavailable-case-checkout");
    const unavailableCaseVariant = join(root, "unavailable-CASE-CHECKOUT");
    const unavailableMetadata = join(root, "unavailable-case-metadata");
    makeStandaloneMetadata(
      unavailableCheckout,
      unavailableMetadata,
      `[core]\nworktree = ${unavailableCaseVariant}\n`,
    );
    caseInsensitivePath.from = unavailableCaseVariant;
    caseInsensitivePath.to = unavailableCheckout;
    directoryAuthRace.openPath = unavailableCaseVariant;
    directoryAuthRace.openError = new Error("synthetic case-variant open failure");
    expect(() => resolveGitProjectAnchor(unavailableCheckout)).toThrow(
      "topology does not point",
    );

    for (const [identitySide, identityField] of [
      ["from", "dev"],
      ["from", "ino"],
      ["to", "dev"],
      ["to", "ino"],
    ] as const) {
      resetDirectoryAuthRace();
      clearGitProjectAnchorCache();
      const name = `zero-${identitySide}-${identityField}`;
      const zeroCheckout = join(root, `${name}-case-checkout`);
      const differentlyCasedCheckout = join(root, `${name}-CASE-CHECKOUT`);
      const zeroMetadata = join(root, `${name}-case-metadata`);
      makeStandaloneMetadata(
        zeroCheckout,
        zeroMetadata,
        `[core]\nworktree = ${differentlyCasedCheckout}\n`,
      );
      caseInsensitivePath.from = differentlyCasedCheckout;
      caseInsensitivePath.to = zeroCheckout;
      caseInsensitivePath[identitySide === "from"
        ? "zeroFromField"
        : "zeroToField"] = identityField;
      directoryAuthRace.unsupportedFlag = "directory";
      expect(() => resolveGitProjectAnchor(zeroCheckout)).toThrow(
        "topology does not point",
      );
    }

    for (const identityField of ["dev", "ino"] as const) {
      resetDirectoryAuthRace();
      clearGitProjectAnchorCache();
      const exactCheckout = join(root, `zero-exact-${identityField}-checkout`);
      const exactMetadata = join(root, `zero-exact-${identityField}-metadata`);
      makeStandaloneMetadata(
        exactCheckout,
        exactMetadata,
        `[core]\nworktree = ${exactCheckout}\n`,
      );
      caseInsensitivePath.to = exactCheckout;
      caseInsensitivePath.zeroToField = identityField;
      directoryAuthRace.unsupportedFlag = "directory";
      expect(resolveGitProjectAnchor(exactCheckout)?.canonical).toBe(
        exactMetadata,
      );
    }

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();

    const absentCheckout = join(root, "absent-checkout");
    const absentMetadata = join(root, "absent-metadata");
    makeStandaloneMetadata(
      absentCheckout,
      absentMetadata,
      "[core]\nrepositoryformatversion = 0\n",
    );
    expect(() => resolveGitProjectAnchor(absentCheckout)).toThrow(
      "expected one core.worktree path",
    );

    const relativeAbsentCheckout = join(root, "relative-absent-checkout");
    const relativeAbsentMetadata = join(root, "relative-absent-metadata");
    makeStandaloneMetadata(
      relativeAbsentCheckout,
      relativeAbsentMetadata,
      "[core]\nrepositoryformatversion = 0\n",
      false,
    );
    expect(() => resolveGitProjectAnchor(relativeAbsentCheckout)).toThrow(
      "expected one core.worktree path",
    );

    const mismatchCheckout = join(root, "mismatch-checkout");
    const mismatchMetadata = join(root, "mismatch-metadata");
    makeStandaloneMetadata(
      mismatchCheckout,
      mismatchMetadata,
      `[core]\nworktree = ${absentCheckout}\n`,
    );
    expect(() => resolveGitProjectAnchor(mismatchCheckout)).toThrow(
      "topology does not point",
    );

    const relativeMismatchCheckout = join(root, "relative-mismatch-checkout");
    const relativeMismatchMetadata = join(root, "relative-mismatch-metadata");
    makeStandaloneMetadata(
      relativeMismatchCheckout,
      relativeMismatchMetadata,
      `[core]\nworktree = ${absentCheckout}\n`,
      false,
    );
    expect(() => resolveGitProjectAnchor(relativeMismatchCheckout)).toThrow(
      "topology does not point",
    );

    const nestedRelativeCheckout = join(root, "nested", "relative-checkout");
    const nonSiblingMetadata = join(root, "non-sibling-metadata");
    makeStandaloneMetadata(
      nestedRelativeCheckout,
      nonSiblingMetadata,
      `[core]\nworktree = ${nestedRelativeCheckout}\n`,
      false,
    );
    expect(resolveGitProjectAnchor(nestedRelativeCheckout)?.canonical).toBe(
      nestedRelativeCheckout,
    );

    const continuedCheckout = join(root, "continued-checkout");
    const continuedMetadata = join(root, "continued-metadata");
    makeStandaloneMetadata(
      continuedCheckout,
      continuedMetadata,
      [
        "[core]",
        `worktree = ${continuedCheckout}`,
        "[other]",
        'value = "first\\',
        'second" # comment\\',
        "[core]",
        `worktree = ${mismatchCheckout}`,
        "",
      ].join("\n"),
    );
    expect(git(
      root,
      "config",
      "--file",
      join(continuedMetadata, "config"),
      "--get",
      "core.worktree",
    )).toBe(mismatchCheckout);
    expect(() => resolveGitProjectAnchor(continuedCheckout)).toThrow(
      "topology does not point",
    );

    const emptyCheckout = join(root, "empty-checkout");
    const emptyMetadata = join(root, "empty-metadata");
    makeStandaloneMetadata(emptyCheckout, emptyMetadata, "[core]\nworktree = \n");
    expect(() => resolveGitProjectAnchor(emptyCheckout)).toThrow(
      "expected one core.worktree path",
    );

    const invalidCheckout = join(root, "invalid-checkout");
    const invalidMetadata = join(root, "invalid-metadata");
    makeStandaloneMetadata(
      invalidCheckout,
      invalidMetadata,
      `[core]\nworktree = ${invalidCheckout}\n[extensions]\nworktreeConfig = maybe\n`,
    );
    expect(() => resolveGitProjectAnchor(invalidCheckout)).toThrow(
      "ambiguous worktree configuration",
    );

    const dottedCheckout = join(root, "dotted-checkout");
    const dottedMetadata = join(root, "dotted-metadata");
    makeStandaloneMetadata(
      dottedCheckout,
      dottedMetadata,
      `[core]\nworktree = ${dottedCheckout}\n[other.]\nkey = value\n`,
    );
    expect(() => resolveGitProjectAnchor(dottedCheckout)).toThrow(
      "ambiguous worktree configuration",
    );

    for (const [name, includeSection] of [
      ["include", "[include]"],
      ["include-if", '[includeIf "gitdir:/**"]'],
    ] as const) {
      const includeCheckout = join(root, `${name}-checkout`);
      const includeMetadata = join(root, `${name}-metadata`);
      makeStandaloneMetadata(
        includeCheckout,
        includeMetadata,
        `[core]\nworktree = ${includeCheckout}\n${includeSection}\npath = override.config\n`,
      );
      expect(() => resolveGitProjectAnchor(includeCheckout)).toThrow(
        "ambiguous worktree configuration",
      );
    }

    const symlinkCheckout = makeDirectory(join(root, "symlink-checkout"));
    const symlinkAlias = join(root, "symlink-worktree");
    symlinkSync(symlinkCheckout, symlinkAlias);
    const symlinkMetadata = join(root, "symlink-metadata");
    makeStandaloneMetadata(
      symlinkCheckout,
      symlinkMetadata,
      `[core]\nworktree = ${symlinkAlias}\n`,
    );
    expect(() => resolveGitProjectAnchor(symlinkCheckout)).toThrow(
      "topology does not point",
    );

    const parentAliasCheckout = makeDirectory(join(root, "parent-alias-checkout"));
    const parentAlias = join(root, "parent-alias");
    symlinkSync(root, parentAlias);
    const parentAliasMetadata = join(root, "parent-alias-metadata");
    makeStandaloneMetadata(
      parentAliasCheckout,
      parentAliasMetadata,
      `[core]\nworktree = ${join(parentAlias, "parent-alias-checkout")}\n`,
    );
    expect(() => resolveGitProjectAnchor(parentAliasCheckout)).toThrow(
      "topology does not point",
    );

    const pointerSymlinkCheckout = makeDirectory(join(root, "pointer-symlink-checkout"));
    const pointerSymlinkTarget = join(root, "pointer-symlink-target");
    makeStandaloneMetadata(
      join(root, "pointer-symlink-source"),
      pointerSymlinkTarget,
      `[core]\nworktree = ${pointerSymlinkCheckout}\n`,
    );
    symlinkSync(pointerSymlinkTarget, join(root, "pointer-symlink-metadata"));
    writeFileSync(
      join(pointerSymlinkCheckout, ".git"),
      `gitdir: ${join(root, "pointer-symlink-metadata")}\n`,
    );
    expect(() => resolveGitProjectAnchor(pointerSymlinkCheckout)).toThrow(
      "invalid Git directory",
    );

    const pointerAliasCheckout = makeDirectory(join(root, "pointer-alias-checkout"));
    const pointerAliasSource = join(root, "pointer-alias-source");
    const pointerAliasMetadata = join(pointerAliasSource, "metadata");
    makeStandaloneMetadata(
      join(root, "pointer-alias-unused"),
      pointerAliasMetadata,
      `[core]\nworktree = ${pointerAliasCheckout}\n`,
    );
    const pointerAliasParent = join(root, "pointer-alias-parent");
    symlinkSync(pointerAliasSource, pointerAliasParent);
    writeFileSync(
      join(pointerAliasCheckout, ".git"),
      `gitdir: ${join(pointerAliasParent, "metadata")}\n`,
    );
    expect(() => resolveGitProjectAnchor(pointerAliasCheckout)).toThrow(
      "Git directory path alias",
    );
  });

  it("accepts authenticated case-only Git directory pointer spellings", () => {
    const acceptCasePointer = (
      checkout: string,
      requestedGitDir: string,
      canonicalGitDir: string,
      expectedCanonical: string,
    ): void => {
      caseInsensitivePath.from = requestedGitDir;
      caseInsensitivePath.to = canonicalGitDir;
      caseInsensitivePath.realpathReturnsMapped = true;
      expect(resolveGitProjectAnchor(checkout)?.canonical).toBe(
        expectedCanonical,
      );
    };

    const absoluteCheckout = join(root, "absolute-pointer-checkout");
    const absoluteGitDir = join(root, "Absolute-Pointer-Metadata");
    const requestedAbsoluteGitDir = join(root, "absolute-pointer-metadata");
    makeStandaloneMetadata(
      absoluteCheckout,
      absoluteGitDir,
      `[core]\nworktree = ${absoluteCheckout}\n`,
    );
    writeFileSync(
      join(absoluteCheckout, ".git"),
      `gitdir: ${requestedAbsoluteGitDir}\n`,
    );
    acceptCasePointer(
      absoluteCheckout,
      requestedAbsoluteGitDir,
      absoluteGitDir,
      absoluteGitDir,
    );

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const relativeCheckout = join(root, "relative-pointer-checkout");
    const relativeGitDir = join(root, "Relative-Pointer-Metadata");
    const requestedRelativeGitDir = join(root, "relative-pointer-metadata");
    makeStandaloneMetadata(
      relativeCheckout,
      relativeGitDir,
      `[core]\nworktree = ${relativeCheckout}\n`,
    );
    writeFileSync(
      join(relativeCheckout, ".git"),
      `gitdir: ${relative(relativeCheckout, requestedRelativeGitDir)}\n`,
    );
    acceptCasePointer(
      relativeCheckout,
      requestedRelativeGitDir,
      relativeGitDir,
      relativeCheckout,
    );

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const primary = makeRepository(join(root, "pointer-primary"));
    const linked = makeLinkedWorktree(
      primary,
      join(root, "pointer-linked"),
      "Linked-Entry",
    );
    const linkedGitDir = join(
      primary,
      ".git",
      "worktrees",
      "Linked-Entry",
    );
    const requestedLinkedGitDir = join(
      primary,
      ".git",
      "WORKTREES",
      "linked-entry",
    );
    writeFileSync(join(linked, ".git"), `gitdir: ${requestedLinkedGitDir}\n`);
    acceptCasePointer(linked, requestedLinkedGitDir, linkedGitDir, primary);

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const preservingCheckout = join(root, "preserving-pointer-checkout");
    const preservingGitDir = join(root, "preserving-pointer-metadata");
    makeStandaloneMetadata(
      preservingCheckout,
      preservingGitDir,
      `[core]\nworktree = ${preservingCheckout}\n`,
    );
    caseInsensitivePath.from = preservingGitDir;
    caseInsensitivePath.to = preservingGitDir;
    expect(resolveGitProjectAnchor(preservingCheckout)?.canonical).toBe(
      preservingGitDir,
    );
  });

  it("rejects changed case-only Git directory pointer evidence", () => {
    const checkout = join(root, "changed-pointer-evidence-checkout");
    const gitDir = join(root, "Changed-Pointer-Evidence-Metadata");
    const requestedGitDir = join(root, "changed-pointer-evidence-metadata");
    makeStandaloneMetadata(
      checkout,
      gitDir,
      `[core]\nworktree = ${checkout}\n`,
    );
    writeFileSync(join(checkout, ".git"), `gitdir: ${requestedGitDir}\n`);
    caseInsensitivePath.from = requestedGitDir;
    caseInsensitivePath.to = gitDir;
    caseInsensitivePath.realpathReturnsMapped = true;
    componentDirectory.path = root;
    componentDirectory.entryPath = requestedGitDir;
    componentDirectory.entryTarget = gitDir;
    componentDirectory.plans = [
      { entries: [Buffer.from("Changed-Pointer-Evidence-Metadata")] },
      { entries: [Buffer.from("changed-pointer-evidence-metadata")] },
    ];
    expect(() => resolveGitProjectAnchor(checkout)).toThrow(
      "case evidence changed",
    );
    expect(componentDirectory.openCount).toBe(2);
    expect(componentDirectory.closeCount).toBe(2);

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const identityCheckout = join(root, "different-pointer-identity-checkout");
    const canonicalGitDir = join(root, "Different-Pointer-Identity-Metadata");
    const requestedIdentityGitDir = join(
      root,
      "different-pointer-identity-metadata",
    );
    const redirectedGitDir = makeDirectory(
      join(root, "redirected-pointer-identity-metadata"),
    );
    makeStandaloneMetadata(
      identityCheckout,
      canonicalGitDir,
      `[core]\nworktree = ${identityCheckout}\n`,
    );
    writeFileSync(
      join(identityCheckout, ".git"),
      `gitdir: ${requestedIdentityGitDir}\n`,
    );
    caseInsensitivePath.from = requestedIdentityGitDir;
    caseInsensitivePath.to = redirectedGitDir;
    caseInsensitivePath.realpathReturnsMapped = true;
    caseInsensitivePath.realpathTo = canonicalGitDir;
    expect(() => resolveGitProjectAnchor(identityCheckout)).toThrow(
      "Git directory changed during validation",
    );

    for (const identityField of ["dev", "ino"] as const) {
      resetDirectoryAuthRace();
      clearGitProjectAnchorCache();
      const zeroCheckout = join(
        root,
        `zero-pointer-${identityField}-checkout`,
      );
      const zeroGitDir = join(
        root,
        `Zero-Pointer-${identityField}-Metadata`,
      );
      const requestedZeroGitDir = join(
        root,
        `zero-pointer-${identityField}-metadata`,
      );
      makeStandaloneMetadata(
        zeroCheckout,
        zeroGitDir,
        `[core]\nworktree = ${zeroCheckout}\n`,
      );
      writeFileSync(
        join(zeroCheckout, ".git"),
        `gitdir: ${requestedZeroGitDir}\n`,
      );
      caseInsensitivePath.from = requestedZeroGitDir;
      caseInsensitivePath.to = zeroGitDir;
      caseInsensitivePath.realpathReturnsMapped = true;
      caseInsensitivePath.zeroFromField = identityField;
      caseInsensitivePath.zeroToField = identityField;
      directoryAuthRace.unsupportedFlag = "directory";
      expect(() => resolveGitProjectAnchor(zeroCheckout)).toThrow(
        "Git directory changed during validation",
      );
    }
  });

  it("bounds and revalidates case-variant component evidence", () => {
    const makeCaseVariant = (
      name: string,
      canonicalParentName: string,
      configuredParentName: string,
    ): {
      canonicalParent: string;
      checkout: string;
      configuredPath: string;
      metadata: string;
    } => {
      const canonicalParent = join(root, canonicalParentName);
      const checkout = join(canonicalParent, "checkout");
      const configuredPath = join(root, configuredParentName, "checkout");
      const metadata = join(root, `${name}-metadata`);
      makeStandaloneMetadata(
        checkout,
        metadata,
        `[core]\nworktree = ${configuredPath}\n`,
      );
      caseInsensitivePath.from = configuredPath;
      caseInsensitivePath.to = checkout;
      return { canonicalParent, checkout, configuredPath, metadata };
    };

    const bindEquivalent = makeCaseVariant(
      "bind-equivalent",
      "Bind-Foo",
      "bind-foo",
    );
    makeDirectory(join(root, "bind-foo"));
    expect(() => resolveGitProjectAnchor(bindEquivalent.checkout)).toThrow(
      "topology does not point",
    );

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const changed = makeCaseVariant(
      "changed-evidence",
      "Snapshot-Parent",
      "snapshot-parent",
    );
    makeDirectory(join(root, "snapshot-parent"));
    componentDirectory.path = root;
    componentDirectory.plans = [
      { entries: [Buffer.from("Snapshot-Parent")] },
      { entries: [Buffer.from("snapshot-parent")] },
    ];
    expect(() => resolveGitProjectAnchor(changed.checkout)).toThrow(
      "component evidence changed",
    );
    expect(componentDirectory.openCount).toBe(2);
    expect(componentDirectory.closeCount).toBe(2);
    expect(componentDirectory.options).toEqual([
      { bufferSize: 32, encoding: "buffer" },
      { bufferSize: 32, encoding: "buffer" },
    ]);

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const revalidationError = makeCaseVariant(
      "revalidation-error",
      "Revalidation-Parent",
      "revalidation-parent",
    );
    componentDirectory.path = root;
    componentDirectory.plans = [
      { entries: [Buffer.from("Revalidation-Parent")] },
      { readErrorAt: 1 },
    ];
    expect(() => resolveGitProjectAnchor(revalidationError.checkout)).toThrow(
      "topology does not point",
    );
    expect(componentDirectory.openCount).toBe(2);
    expect(componentDirectory.closeCount).toBe(2);

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const symlinked = makeCaseVariant(
      "symlink-evidence",
      "Symlink-Parent",
      "symlink-parent",
    );
    const symlinkEntry = join(root, "symlink-parent");
    symlinkSync(symlinked.canonicalParent, symlinkEntry);
    componentDirectory.path = root;
    componentDirectory.directorySymlinkPath = symlinkEntry;
    componentDirectory.plans = [
      { entries: [Buffer.from("symlink-parent")] },
    ];
    expect(() => resolveGitProjectAnchor(symlinked.checkout)).toThrow(
      "topology does not point",
    );
    expect(componentDirectory.closeCount).toBe(1);

    const expectEnumerationFailure = (
      name: string,
      plan: (typeof componentDirectory.plans)[number],
      expectedCloses = 1,
    ): void => {
      resetDirectoryAuthRace();
      clearGitProjectAnchorCache();
      const canonicalParentName = `${name}-Parent`;
      const fixture = makeCaseVariant(
        name,
        canonicalParentName,
        `${name}-parent`,
      );
      componentDirectory.path = root;
      componentDirectory.plans = [plan];
      expect(() => resolveGitProjectAnchor(fixture.checkout)).toThrow(
        "topology does not point",
      );
      expect(componentDirectory.openCount).toBe(1);
      expect(componentDirectory.closeCount).toBe(expectedCloses);
    };

    expectEnumerationFailure("open-error", {
      openError: new Error("synthetic component directory open failure"),
    }, 0);
    expectEnumerationFailure("read-error", { readErrorAt: 1 });
    expectEnumerationFailure("close-error", {
      closeError: new Error("synthetic component directory close failure"),
      entries: [Buffer.from("close-error-Parent")],
    });
    expectEnumerationFailure("missing-entry", {
      entries: [Buffer.from("unrelated")],
    });
    expectEnumerationFailure("entry-bound", {
      repeat: { count: 4_097, name: Buffer.from("unrelated") },
    });
    expectEnumerationFailure("byte-bound", {
      entries: [Buffer.alloc(1024 * 1024 + 1, 0x61)],
    });
    expectEnumerationFailure("malformed-name", {
      entries: [Buffer.from([0xff])],
    });

    const expectEnumerationSuccess = (
      name: string,
      plan: (typeof componentDirectory.plans)[number],
    ): void => {
      resetDirectoryAuthRace();
      clearGitProjectAnchorCache();
      const fixture = makeCaseVariant(
        name,
        `${name}-Parent`,
        `${name}-parent`,
      );
      componentDirectory.path = root;
      componentDirectory.plans = [plan, plan, plan, plan];
      expect(resolveGitProjectAnchor(fixture.checkout)?.canonical).toBe(
        fixture.metadata,
      );
      expect(componentDirectory.openCount).toBe(4);
      expect(componentDirectory.closeCount).toBe(4);
    };

    const exactEntryName = "entry-exact-Parent";
    expectEnumerationSuccess("entry-exact", {
      entries: [Buffer.from(exactEntryName)],
      repeat: { count: 4_095, name: Buffer.from("unrelated") },
    });
    const exactByteName = "byte-exact-Parent";
    expectEnumerationSuccess("byte-exact", {
      entries: [Buffer.from(exactByteName)],
      repeat: {
        count: 1,
        name: Buffer.alloc(
          1024 * 1024 - Buffer.byteLength(exactByteName),
          0x61,
        ),
      },
    });

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const windowsDrive = makeCaseVariant(
      "windows-drive-root",
      "Drive-Parent",
      "drive-parent",
    );
    const configuredDriveRoot = "c:\\";
    const canonicalDriveRoot = "C:\\";
    pathBoundary.parseRoots.set(windowsDrive.configuredPath, configuredDriveRoot);
    pathBoundary.parseRoots.set(windowsDrive.checkout, canonicalDriveRoot);
    const configuredComponents = windowsDrive.configuredPath
      .slice(configuredDriveRoot.length)
      .split("/");
    const canonicalComponents = windowsDrive.checkout
      .slice(canonicalDriveRoot.length)
      .split("/");
    const variantIndex = configuredComponents.findIndex(
      (component, index) => component !== canonicalComponents[index],
    );
    expect(variantIndex).toBeGreaterThanOrEqual(0);
    const evidenceParent = canonicalComponents
      .slice(0, variantIndex)
      .reduce((parent, component) => join(parent, component), canonicalDriveRoot);
    const actualComponent = canonicalComponents[variantIndex]!;
    componentDirectory.path = evidenceParent;
    componentDirectory.entryPath = join(evidenceParent, actualComponent);
    componentDirectory.entryTarget = windowsDrive.canonicalParent;
    componentDirectory.plans = [
      { entries: [Buffer.from(actualComponent)] },
      { entries: [Buffer.from(actualComponent)] },
      { entries: [Buffer.from(actualComponent)] },
      { entries: [Buffer.from(actualComponent)] },
    ];
    expect(resolveGitProjectAnchor(windowsDrive.checkout)?.canonical).toBe(
      windowsDrive.metadata,
    );
    expect(componentDirectory.closeCount).toBe(4);

    const expectRejectedRoots = (
      name: string,
      configuredRoot: string,
      canonicalRoot: string,
    ): void => {
      resetDirectoryAuthRace();
      clearGitProjectAnchorCache();
      pathBoundary.parseRoots.clear();
      const fixture = makeCaseVariant(
        name,
        `${name}-Parent`,
        `${name}-parent`,
      );
      pathBoundary.parseRoots.set(fixture.configuredPath, configuredRoot);
      pathBoundary.parseRoots.set(fixture.checkout, canonicalRoot);
      expect(() => resolveGitProjectAnchor(fixture.checkout)).toThrow(
        "topology does not point",
      );
      expect(componentDirectory.openCount).toBe(0);
    };
    expectRejectedRoots("different-drive-root", "D:\\", "C:\\");
    expectRejectedRoots(
      "unc-case-root",
      "\\\\server\\share\\",
      "\\\\SERVER\\share\\",
    );
    expectRejectedRoots("drive-to-unc-root", "c:\\", "\\\\server\\share\\");

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    pathBoundary.parseRoots.clear();
    const foreignRoot = makeCaseVariant(
      "foreign-root",
      "Root-Parent",
      "root-parent",
    );
    pathBoundary.parseRootPath = foreignRoot.configuredPath;
    pathBoundary.parseRoot = "foreign-root:";
    expect(() => resolveGitProjectAnchor(foreignRoot.checkout)).toThrow(
      "topology does not point",
    );
    expect(componentDirectory.openCount).toBe(0);
  });

  it("contains repository-local commondir metadata and revalidates it", () => {
    const local = makeRepository(join(root, "local-common"));
    const external = makeRepository(join(root, "external-common"));
    writeFileSync(join(local, ".git", "commondir"), `${join(external, ".git")}\n`);
    expect(() => resolveGitProjectAnchor(local)).toThrow("escapes");

    const contained = makeRepository(join(root, "contained-common"));
    const containedMetadata = makeDirectory(join(contained, ".git", "shared"));
    makeDirectory(join(containedMetadata, "objects"));
    writeFileSync(
      join(containedMetadata, "config"),
      "[core]\nrepositoryformatversion = 0\n",
    );
    writeFileSync(join(contained, ".git", "commondir"), "shared\n");
    expect(resolveGitProjectAnchor(contained)).toEqual({
      canonical: containedMetadata,
      worktreeRoot: contained,
      commonDir: containedMetadata,
    });

    const symlinked = makeRepository(join(root, "symlinked-common"));
    symlinkSync(join(external, ".git"), join(symlinked, ".git", "shared"));
    writeFileSync(join(symlinked, ".git", "commondir"), "shared\n");
    expect(() => resolveGitProjectAnchor(symlinked)).toThrow(
      "invalid Git common directory",
    );

    const commonAlias = makeRepository(join(root, "common-alias"));
    const commonAliasParent = join(root, "common-alias-parent");
    symlinkSync(root, commonAliasParent);
    writeFileSync(
      join(commonAlias, ".git", "commondir"),
      `${join(commonAliasParent, "external-common", ".git")}\n`,
    );
    expect(() => resolveGitProjectAnchor(commonAlias)).toThrow(
      "Git common directory path alias",
    );

    const raced = makeRepository(join(root, "raced-common"));
    const first = makeDirectory(join(raced, ".git", "first"));
    makeDirectory(join(first, "objects"));
    writeFileSync(join(first, "config"), "[core]\nrepositoryformatversion = 0\n");
    writeFileSync(join(raced, ".git", "commondir"), "first\n");
    let swapped = false;
    metadataRace.afterRead = (path): void => {
      if (!swapped && path === join(raced, ".git", "commondir")) {
        swapped = true;
        writeFileSync(join(raced, ".git", "commondir"), `${join(external, ".git")}\n`);
      }
    };
    expect(() => resolveGitProjectAnchor(raced)).toThrow(
      "common-directory metadata changed",
    );
  });

  it("revalidates standalone pointers, config bytes, and directory identity", () => {
    const makeVerified = (name: string): { checkout: string; metadata: string } => {
      const checkout = join(root, `${name}-checkout`);
      const metadata = join(root, `${name}-metadata`);
      makeStandaloneMetadata(
        checkout,
        metadata,
        `[core]\nworktree = ../${name}-checkout\n`,
      );
      return { checkout, metadata };
    };

    const configRace = makeVerified("config-race");
    let configSwapped = false;
    metadataRace.afterRead = (path): void => {
      if (!configSwapped && path === join(configRace.metadata, "config")) {
        configSwapped = true;
        writeFileSync(
          path,
          `[core]\nworktree = ${configRace.checkout}\n# changed bytes\n`,
        );
      }
    };
    expect(() => resolveGitProjectAnchor(configRace.checkout)).toThrow(
      "core.worktree metadata changed",
    );

    metadataRace.afterRead = undefined;
    const markerRace = makeVerified("marker-race");
    const replacement = makeVerified("marker-replacement");
    let markerSwapped = false;
    metadataRace.afterRead = (path): void => {
      if (!markerSwapped && path === join(markerRace.metadata, "config")) {
        markerSwapped = true;
        writeFileSync(
          join(markerRace.checkout, ".git"),
          `gitdir: ${replacement.metadata}\n`,
        );
      }
    };
    expect(() => resolveGitProjectAnchor(markerRace.checkout)).toThrow(
      "worktree metadata changed",
    );

    metadataRace.afterRead = undefined;
    const pointerFormRace = makeVerified("pointer-form-race");
    let pointerFormSwapped = false;
    metadataRace.afterRead = (path): void => {
      if (!pointerFormSwapped && path === join(pointerFormRace.metadata, "config")) {
        pointerFormSwapped = true;
        writeFileSync(
          join(pointerFormRace.checkout, ".git"),
          "gitdir: ../pointer-form-race-metadata\n",
        );
      }
    };
    expect(() => resolveGitProjectAnchor(pointerFormRace.checkout)).toThrow(
      "worktree metadata changed",
    );

    metadataRace.afterRead = undefined;
    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const pointerCaseRace = makeVerified("pointer-case-race");
    const requestedPointerCase = join(root, "POINTER-CASE-RACE-METADATA");
    writeFileSync(
      join(pointerCaseRace.checkout, ".git"),
      `gitdir: ${requestedPointerCase}\n`,
    );
    caseInsensitivePath.from = requestedPointerCase;
    caseInsensitivePath.to = pointerCaseRace.metadata;
    caseInsensitivePath.realpathReturnsMapped = true;
    let pointerCaseSwapped = false;
    metadataRace.afterRead = (path): void => {
      if (!pointerCaseSwapped && path === join(pointerCaseRace.metadata, "config")) {
        pointerCaseSwapped = true;
        writeFileSync(
          join(pointerCaseRace.checkout, ".git"),
          `gitdir: ${pointerCaseRace.metadata}\n`,
        );
      }
    };
    expect(() => resolveGitProjectAnchor(pointerCaseRace.checkout)).toThrow(
      "worktree metadata changed",
    );

    metadataRace.afterRead = undefined;
    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const directoryRace = makeVerified("directory-race");
    const retired = join(root, "directory-race-retired");
    let directorySwapped = false;
    metadataRace.afterRead = (path): void => {
      if (!directorySwapped && path === join(directoryRace.metadata, "config")) {
        directorySwapped = true;
        renameSync(directoryRace.metadata, retired);
        makeDirectory(join(directoryRace.metadata, "objects"));
        writeFileSync(join(directoryRace.metadata, "HEAD"), "ref: refs/heads/main\n");
        writeFileSync(
          join(directoryRace.metadata, "config"),
          `[core]\nworktree = ${directoryRace.checkout}\n`,
        );
      }
    };
    expect(() => resolveGitProjectAnchor(directoryRace.checkout)).toThrow(
      "Git directory changed during validation",
    );
  });

  it("fails closed when directory authentication observes substituted metadata", () => {
    const initialInvalid = makeRepository(join(root, "initial-invalid-auth-directory"));
    directoryAuthRace.openPath = join(initialInvalid, ".git");
    directoryAuthRace.lstatPath = join(initialInvalid, ".git");
    directoryAuthRace.invalidDirectoryAt = 2;
    directoryAuthRace.unsupportedFlag = "directory";
    expect(() => resolveGitProjectAnchor(initialInvalid)).toThrow(
      "invalid Git directory",
    );
    expect(directoryAuthRace.closeCount).toBe(0);

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const invalid = makeRepository(join(root, "invalid-auth-directory"));
    directoryAuthRace.openPath = join(invalid, ".git");
    directoryAuthRace.lstatPath = join(invalid, ".git");
    directoryAuthRace.invalidDirectoryAt = 2;
    expect(() => resolveGitProjectAnchor(invalid)).toThrow("invalid Git directory");
    expect(directoryAuthRace.closeCount).toBe(1);

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const changed = makeRepository(join(root, "changed-auth-directory"));
    directoryAuthRace.openPath = join(changed, ".git");
    directoryAuthRace.descriptorMismatchAt = 1;
    expect(() => resolveGitProjectAnchor(changed)).toThrow(
      "Git directory changed during validation",
    );
    expect(directoryAuthRace.closeCount).toBe(1);
  });

  it("descriptor-authenticates strict Git directories and exact core.worktree evidence", () => {
    const primary = makeRepository(join(root, "descriptor-primary"));
    const primaryAlias = join(root, "descriptor-primary-alias");
    symlinkSync(primary, primaryAlias);
    directoryAuthRace.openPath = join(primary, ".git");

    expect(resolveGitProjectAnchor(primaryAlias)).toEqual({
      canonical: primary,
      worktreeRoot: primary,
      commonDir: join(primary, ".git"),
    });
    expect(directoryAuthRace.openCount).toBe(2);
    expect(directoryAuthRace.fstatCount).toBe(2);
    expect(directoryAuthRace.closeCount).toBe(2);
    expect(directoryAuthRace.openFlags).toBe(
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const linked = makeLinkedWorktree(
      primary,
      join(root, "descriptor-linked"),
      "descriptor-linked",
    );
    directoryAuthRace.openPath = join(primary, ".git");
    expect(resolveGitProjectAnchor(linked)?.canonical).toBe(primary);
    expect(directoryAuthRace.openCount).toBe(2);
    expect(directoryAuthRace.fstatCount).toBe(2);
    expect(directoryAuthRace.closeCount).toBe(2);

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const checkout = join(root, "descriptor-checkout");
    const metadata = join(root, "descriptor-metadata");
    makeStandaloneMetadata(
      checkout,
      metadata,
      `[core]\nworktree = ${checkout}\n`,
    );
    directoryAuthRace.openPath = checkout;
    directoryAuthRace.lstatPath = checkout;
    directoryAuthRace.beforeOpen = (): void => {
      if (directoryAuthRace.openCount === 1) {
        expect(directoryAuthRace.lstatCount).toBe(0);
      }
    };
    expect(resolveGitProjectAnchor(checkout)?.canonical).toBe(metadata);
    expect(directoryAuthRace.openCount).toBe(2);
    expect(directoryAuthRace.fstatCount).toBe(2);
    expect(directoryAuthRace.lstatCount).toBe(2);
    expect(directoryAuthRace.closeCount).toBe(2);

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const invalidCheckout = join(root, "invalid-descriptor-checkout");
    const invalidMetadata = join(root, "invalid-descriptor-metadata");
    const coreWorktreeError = new Error("synthetic core.worktree open failure");
    makeStandaloneMetadata(
      invalidCheckout,
      invalidMetadata,
      `[core]\nworktree = ${invalidCheckout}\n`,
    );
    directoryAuthRace.openPath = invalidCheckout;
    directoryAuthRace.openError = coreWorktreeError;
    expect(() => resolveGitProjectAnchor(invalidCheckout)).toThrow(
      coreWorktreeError,
    );
  });

  it("rejects directory substitutions before open and while a descriptor is held", () => {
    const beforeOpen = makeRepository(join(root, "before-open-substitution"));
    const beforeOpenGitDir = join(beforeOpen, ".git");
    const beforeOpenRetired = join(beforeOpen, ".git-retired");
    directoryAuthRace.openPath = beforeOpenGitDir;
    directoryAuthRace.beforeOpen = (): void => {
      renameSync(beforeOpenGitDir, beforeOpenRetired);
      symlinkSync(beforeOpenRetired, beforeOpenGitDir);
    };
    expect(() => resolveGitProjectAnchor(beforeOpen)).toThrow();
    expect(directoryAuthRace.openCount).toBe(1);
    expect(directoryAuthRace.fstatCount).toBe(0);
    expect(directoryAuthRace.closeCount).toBe(0);

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const beforeOpenReplacement = makeRepository(
      join(root, "before-open-directory-replacement"),
    );
    const beforeOpenReplacementGitDir = join(beforeOpenReplacement, ".git");
    const beforeOpenReplacementRetired = join(
      beforeOpenReplacement,
      ".git-retired",
    );
    directoryAuthRace.openPath = beforeOpenReplacementGitDir;
    let replacedBeforeOpen = false;
    directoryAuthRace.beforeOpen = (): void => {
      if (replacedBeforeOpen) return;
      replacedBeforeOpen = true;
      renameSync(beforeOpenReplacementGitDir, beforeOpenReplacementRetired);
      makeRepository(beforeOpenReplacement);
    };
    expect(resolveGitProjectAnchor(beforeOpenReplacement)?.canonical).toBe(
      beforeOpenReplacement,
    );
    expect(directoryAuthRace.openCount).toBe(2);
    expect(directoryAuthRace.fstatCount).toBe(2);
    expect(directoryAuthRace.closeCount).toBe(2);

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const afterOpen = makeRepository(join(root, "after-open-substitution"));
    const afterOpenGitDir = join(afterOpen, ".git");
    const afterOpenRetired = join(afterOpen, ".git-retired");
    directoryAuthRace.openPath = afterOpenGitDir;
    directoryAuthRace.afterOpen = (): void => {
      renameSync(afterOpenGitDir, afterOpenRetired);
      makeRepository(afterOpen);
    };
    expect(() => resolveGitProjectAnchor(afterOpen)).toThrow(
      "Git directory changed during validation",
    );
    expect(directoryAuthRace.fstatCount).toBe(1);
    expect(directoryAuthRace.closeCount).toBe(1);

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const afterRealpath = makeRepository(join(root, "after-realpath-substitution"));
    const afterRealpathGitDir = join(afterRealpath, ".git");
    const afterRealpathRetired = join(afterRealpath, ".git-retired");
    directoryAuthRace.openPath = afterRealpathGitDir;
    directoryAuthRace.afterRealpathAt = 2;
    directoryAuthRace.afterRealpath = (): void => {
      renameSync(afterRealpathGitDir, afterRealpathRetired);
      symlinkSync(afterRealpathRetired, afterRealpathGitDir);
    };
    expect(() => resolveGitProjectAnchor(afterRealpath)).toThrow(
      "invalid Git directory",
    );
    expect(directoryAuthRace.fstatCount).toBe(1);
    expect(directoryAuthRace.closeCount).toBe(1);
  });

  it("closes directory descriptors across fstat, validation, and close failures", () => {
    const openFailure = makeRepository(join(root, "directory-open-failure"));
    const openError = new Error("synthetic directory open failure");
    directoryAuthRace.openPath = join(openFailure, ".git");
    directoryAuthRace.openError = openError;
    expect(() => resolveGitProjectAnchor(openFailure)).toThrow(openError);
    expect(directoryAuthRace.closeCount).toBe(0);

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const fstatFailure = makeRepository(join(root, "directory-fstat-failure"));
    const fstatError = new Error("synthetic directory fstat failure");
    directoryAuthRace.openPath = join(fstatFailure, ".git");
    directoryAuthRace.fstatError = fstatError;
    expect(() => resolveGitProjectAnchor(fstatFailure)).toThrow(fstatError);
    expect(directoryAuthRace.closeCount).toBe(1);

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const invalidDescriptor = makeRepository(join(root, "invalid-directory-descriptor"));
    directoryAuthRace.openPath = join(invalidDescriptor, ".git");
    directoryAuthRace.invalidDescriptorAt = 1;
    expect(() => resolveGitProjectAnchor(invalidDescriptor)).toThrow(
      "invalid Git directory",
    );
    expect(directoryAuthRace.closeCount).toBe(1);

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const inodeMismatch = makeRepository(join(root, "inode-mismatch-directory"));
    directoryAuthRace.openPath = join(inodeMismatch, ".git");
    directoryAuthRace.descriptorMismatchAt = 1;
    directoryAuthRace.descriptorMismatchField = "ino";
    expect(() => resolveGitProjectAnchor(inodeMismatch)).toThrow(
      "Git directory changed during validation",
    );
    expect(directoryAuthRace.closeCount).toBe(1);

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const closeFailure = makeRepository(join(root, "directory-close-failure"));
    const closeError = new Error("synthetic directory close failure");
    directoryAuthRace.openPath = join(closeFailure, ".git");
    directoryAuthRace.closeError = closeError;
    expect(() => resolveGitProjectAnchor(closeFailure)).toThrow(closeError);
    expect(directoryAuthRace.closeCount).toBe(1);
  });

  it("uses path authentication only when a directory-open flag is unavailable", () => {
    for (const unsupportedFlag of ["directory", "nofollow"] as const) {
      resetDirectoryAuthRace();
      clearGitProjectAnchorCache();
      const repository = makeRepository(join(root, `fallback-${unsupportedFlag}`));
      directoryAuthRace.openPath = join(repository, ".git");
      directoryAuthRace.unsupportedFlag = unsupportedFlag;
      expect(resolveGitProjectAnchor(repository)?.canonical).toBe(repository);
      expect(directoryAuthRace.openCount).toBe(0);
    }

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const invalid = makeRepository(join(root, "fallback-invalid"));
    directoryAuthRace.openPath = join(invalid, ".git");
    directoryAuthRace.unsupportedFlag = "directory";
    directoryAuthRace.lstatPath = join(invalid, ".git");
    directoryAuthRace.invalidDirectoryAt = 3;
    expect(() => resolveGitProjectAnchor(invalid)).toThrow("invalid Git directory");
    expect(directoryAuthRace.openCount).toBe(0);

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();
    const changed = makeRepository(join(root, "fallback-changed"));
    directoryAuthRace.openPath = join(changed, ".git");
    directoryAuthRace.unsupportedFlag = "directory";
    directoryAuthRace.statPath = join(changed, ".git");
    directoryAuthRace.mismatchedStatAt = 2;
    expect(() => resolveGitProjectAnchor(changed)).toThrow(
      "Git directory changed during validation",
    );
  });

  it("rejects malformed and race-changed linked-worktree topology", () => {
    const malformedPrimary = makeRepository(join(root, "malformed-linked-primary"));
    const malformedLinked = makeLinkedWorktree(
      malformedPrimary,
      join(root, "malformed-linked"),
      "malformed-linked",
    );
    writeFileSync(
      join(malformedPrimary, ".git", "worktrees", "malformed-linked", "gitdir"),
      "\n",
    );
    expect(() => resolveGitProjectAnchor(malformedLinked)).toThrow("expected one path");

    const directoryPrimary = makeRepository(join(root, "directory-linked-primary"));
    const directoryLinked = makeLinkedWorktree(
      directoryPrimary,
      join(root, "directory-linked"),
      "directory-linked",
    );
    writeFileSync(
      join(directoryPrimary, ".git", "worktrees", "directory-linked", "gitdir"),
      `${directoryLinked}\n`,
    );
    expect(() => resolveGitProjectAnchor(directoryLinked)).toThrow(
      "backpointer target or worktree marker is not a regular file",
    );

    const missingPrimary = makeRepository(join(root, "missing-worktrees-primary"));
    const missingGitDir = makeDirectory(join(root, "missing-worktrees-entry"));
    writeFileSync(join(missingGitDir, "commondir"), `${join(missingPrimary, ".git")}\n`);
    writeFileSync(join(missingGitDir, "HEAD"), "ref: refs/heads/main\n");
    const missingLinked = makeDirectory(join(root, "missing-worktrees-linked"));
    writeFileSync(join(missingLinked, ".git"), `gitdir: ${missingGitDir}\n`);
    writeFileSync(join(missingGitDir, "gitdir"), `${join(missingLinked, ".git")}\n`);
    expect(() => resolveGitProjectAnchor(missingLinked)).toThrow(
      "invalid Git worktrees directory",
    );

    const filePrimary = makeRepository(join(root, "file-worktrees-primary"));
    writeFileSync(join(filePrimary, ".git", "worktrees"), "not a directory");
    const fileGitDir = makeDirectory(join(root, "file-worktrees-entry"));
    writeFileSync(join(fileGitDir, "commondir"), `${join(filePrimary, ".git")}\n`);
    writeFileSync(join(fileGitDir, "HEAD"), "ref: refs/heads/main\n");
    const fileLinked = makeDirectory(join(root, "file-worktrees-linked"));
    writeFileSync(join(fileLinked, ".git"), `gitdir: ${fileGitDir}\n`);
    writeFileSync(join(fileGitDir, "gitdir"), `${join(fileLinked, ".git")}\n`);
    expect(() => resolveGitProjectAnchor(fileLinked)).toThrow(
      "invalid Git worktrees directory",
    );

    const aliasPrimary = makeRepository(join(root, "alias-worktrees-primary"));
    const canonicalWorktrees = makeDirectory(
      join(aliasPrimary, ".git", "Worktrees"),
    );
    const aliasGitDir = makeDirectory(join(canonicalWorktrees, "entry"));
    writeFileSync(join(aliasGitDir, "commondir"), "../..\n");
    writeFileSync(join(aliasGitDir, "HEAD"), "ref: refs/heads/main\n");
    const aliasLinked = makeDirectory(join(root, "alias-worktrees-linked"));
    writeFileSync(join(aliasLinked, ".git"), `gitdir: ${aliasGitDir}\n`);
    writeFileSync(join(aliasGitDir, "gitdir"), `${join(aliasLinked, ".git")}\n`);
    caseInsensitivePath.from = join(aliasPrimary, ".git", "worktrees");
    caseInsensitivePath.to = canonicalWorktrees;
    caseInsensitivePath.realpathReturnsMapped = true;
    expect(() => resolveGitProjectAnchor(aliasLinked)).toThrow(
      "invalid Git worktrees directory",
    );

    resetDirectoryAuthRace();
    clearGitProjectAnchorCache();

    const nestedPrimary = makeRepository(join(root, "nested-worktrees-primary"));
    const nestedGitDir = makeDirectory(
      join(nestedPrimary, ".git", "worktrees", "nested", "entry"),
    );
    writeFileSync(join(nestedGitDir, "commondir"), "../../..\n");
    writeFileSync(join(nestedGitDir, "HEAD"), "ref: refs/heads/main\n");
    const nestedLinked = makeDirectory(join(root, "nested-worktrees-linked"));
    writeFileSync(join(nestedLinked, ".git"), `gitdir: ${nestedGitDir}\n`);
    writeFileSync(join(nestedGitDir, "gitdir"), `${join(nestedLinked, ".git")}\n`);
    expect(() => resolveGitProjectAnchor(nestedLinked)).toThrow(
      "is not a direct worktree entry",
    );

    const pointerPrimary = makeRepository(join(root, "pointer-race-primary"));
    const pointerLinked = makeLinkedWorktree(
      pointerPrimary,
      join(root, "pointer-race-linked"),
      "pointer-race-linked",
    );
    const pointerBack = join(
      pointerPrimary,
      ".git",
      "worktrees",
      "pointer-race-linked",
      "gitdir",
    );
    let pointerChanged = false;
    metadataRace.afterRead = (path): void => {
      if (!pointerChanged && path === pointerBack) {
        pointerChanged = true;
        writeFileSync(join(pointerLinked, ".git"), `gitdir: ${fileGitDir}\n`);
      }
    };
    expect(() => resolveGitProjectAnchor(pointerLinked)).toThrow(
      "worktree metadata changed during topology validation",
    );

    metadataRace.afterRead = undefined;
    const commonPrimary = makeRepository(join(root, "common-race-primary"));
    const commonLinked = makeLinkedWorktree(
      commonPrimary,
      join(root, "common-race-linked"),
      "common-race-linked",
    );
    const commonPointer = join(
      commonPrimary,
      ".git",
      "worktrees",
      "common-race-linked",
      "commondir",
    );
    let commonMarkerReads = 0;
    metadataRace.afterRead = (path): void => {
      if (path === join(commonLinked, ".git") && ++commonMarkerReads === 2) {
        writeFileSync(commonPointer, `${join(filePrimary, ".git")}\n`);
      }
    };
    expect(() => resolveGitProjectAnchor(commonLinked)).toThrow(
      "common-directory metadata changed during topology validation",
    );

    metadataRace.afterRead = undefined;
    const backPrimary = makeRepository(join(root, "back-race-primary"));
    const backLinked = makeLinkedWorktree(
      backPrimary,
      join(root, "back-race-linked"),
      "back-race-linked",
    );
    const backpointer = join(
      backPrimary,
      ".git",
      "worktrees",
      "back-race-linked",
      "gitdir",
    );
    const backCommonPointer = join(
      backPrimary,
      ".git",
      "worktrees",
      "back-race-linked",
      "commondir",
    );
    let backCommonReads = 0;
    metadataRace.afterRead = (path): void => {
      if (path === backCommonPointer && ++backCommonReads === 2) {
        writeFileSync(backpointer, "missing\n");
      }
    };
    expect(() => resolveGitProjectAnchor(backLinked)).toThrow(
      "worktree backpointer changed during topology validation",
    );
  });

  it("parses supported Git config syntax with linear final-assignment semantics", () => {
    const checkout = join(root, "syntax-checkout");
    const metadata = join(root, "syntax-metadata");
    makeStandaloneMetadata(
      checkout,
      metadata,
      "[core]\nrepositoryformatversion = 0\n",
      false,
    );
    const configPath = join(metadata, "config");
    writeFileSync(
      join(metadata, "config.worktree"),
      `[core]\nworktree = ${checkout}\n`,
    );
    const expectAnchor = (config: string): void => {
      writeFileSync(configPath, config);
      clearGitProjectAnchorCache();
      expect(resolveGitProjectAnchor(checkout)?.canonical, config).toBe(checkout);
    };
    const expectRejected = (config: string): void => {
      writeFileSync(configPath, config);
      clearGitProjectAnchorCache();
      expect(() => resolveGitProjectAnchor(checkout), config).toThrow();
    };

    for (const config of [
      '[Extensions]\r\nWorkTreeConfig = "true" ; quoted\r\n',
      "globalKey = accepted\n[extensions]\nworktreeConfig = true\n",
      "[extensions]\nworktreeConfig = tr\\\nue\n",
      "[extensions]\nworktreeConfig = t\\\nr\\\nue\n",
      "[extensions]\nworktreeConfig = false\nworktreeConfig\n",
      "[extensions \"ignored\"]\nworktreeConfig = false\n[extensions]\nworktreeConfig = yes\n",
      "[extensions.subsection]\nworktreeConfig = false\n[extensions]\nworktreeConfig = on\n",
      "[extensions.sub.section]\nworktreeConfig = false\n[extensions]\nworktreeConfig = on\n",
      "[extensions \"escaped\\\" subsection\"]\nworktreeConfig = false\n[extensions]\nworktreeConfig = 1\n",
      "# leading comment\n; second comment\n[extensions] # section comment\nworktreeConfig = true # comment\\\n",
      "[extensions]worktreeConfig=2 # same-line numeric\n",
      "[extensions] worktreeConfig=+01k; same-line scaled integer\n",
      "[extensions]worktreeConfig\n",
      "[other][extensions]worktreeConfig=2\n",
      "[remote \"origin\"][extensions]worktreeConfig=2\n",
      "[extensions \"ignored\"][extensions]worktreeConfig=2\n",
      "[extensions] trailing\nworktreeConfig = true\n",
      "[extensions]worktreeConfig=0\n[extensions]worktreeConfig=2\n",
    ]) {
      expectAnchor(config);
      expect(git(
        root,
        "config",
        "--file",
        configPath,
        "--bool",
        "--get",
        "extensions.worktreeConfig",
      )).toBe("true");
    }

    const sameLineCore = `[remote "origin"][core]worktree="${checkout}" # backlink\n`;
    expectAnchor(sameLineCore);
    expect(git(
      root,
      "config",
      "--file",
      configPath,
      "--get",
      "core.worktree",
    )).toBe(checkout);

    for (const config of [
      "[extensions]\nworktreeConfig = false\n",
      "[extensions]\nworktreeConfig = maybe\n",
      "[extensions]\nworktreeConfig # invalid implicit comment\n",
      "[extensions]\nworktreeConfig trailing\n",
      "[extensions]\nworktreeConfig = \\\n",
      "[extensions]\nworktreeConfig = \\\\q\n",
      "[extensions]\nworktreeConfig = \\\\n\n",
      "[extensions]\nworktreeConfig = \\\\t\n",
      "[extensions]\nworktreeConfig = \\\\b\n",
      "[extensions]\nworktreeConfig = \\\\\\\n",
      "[extensions]\nworktreeConfig = \\\"\n",
      "[extensions\nworktreeConfig = true\n",
      "[]\nworktreeConfig = true\n",
      "[ extensions]\nworktreeConfig = true\n",
      "[extensions.]\nworktreeConfig = true\n",
      "[extensions nonsense]\nworktreeConfig = true\n",
      "[extensions \"unterminated]\nworktreeConfig = true\n",
      "[extensions \"trailing\" junk]\nworktreeConfig = true\n",
      "[core]\nworktree\n[extensions]\nworktreeConfig = true\n",
      "[core]\nworktree trailing\n[extensions]\nworktreeConfig = true\n",
      "[core]\nworktree = \\q\n[extensions]\nworktreeConfig = true\n",
      "[extensions]\nworktreeConfig = \"unterminated\n",
      "[extensions]\nworktreeConfig = true\nother value\n",
      "[extensions]\nworktreeConfig = true\nother = \\q\n",
      `[extensions]worktreeConfig=2[core]worktree=${checkout}\n`,
      "[include]path=override.config\n[extensions]worktreeConfig=2\n",
      "[includeIf \"gitdir:/**\"]path=override.config\n[extensions]worktreeConfig=2\n",
    ]) {
      expectRejected(config);
    }

    for (const config of [
      "[extensions]\nworktreeConfig = true\n1bad = value\n",
      "[extensions]\nworktreeConfig = true\n-bad = value\n",
      "[other.$]\nkey = value\n[extensions]\nworktreeConfig = true\n",
      " \t[ext\\\nensions]\nworktreeConfig = true\n",
      " \\\n[extensions]\nworktreeConfig = true\n",
      " \uFEFF[extensions]\nworktreeConfig = true\n",
      "\n\uFEFF[extensions]\nworktreeConfig = true\n",
      "\uFEFF\uFEFF[extensions]\nworktreeConfig = true\n",
      "[extensions]\n\vworktreeConfig = true\n",
      "[extensions]\n\fworktreeConfig = true\n",
      "[extensions]$bad=value\nworktreeConfig = true\n",
      "[extensions][\nworktreeConfig = true\n",
      "[remote \"unterminated]url=value\n[extensions]worktreeConfig=2\n",
    ]) {
      writeFileSync(configPath, config);
      const gitResult = spawnSync(
        "git",
        ["config", "--file", configPath, "--list"],
        { encoding: "utf8" },
      );
      expect(gitResult.status, config).not.toBe(0);
      expectRejected(config);
    }

    for (const escaped of ["n", "t", "b", "\\", '"', "q"]) {
      expectRejected(
        `[extensions]\nworktreeConfig = tr${"\\"}${escaped}ue\n`,
      );
    }

    const prefix = "[extensions]\nworktreeConfig = true";
    const suffix = "x\n";
    const adversarial = `${prefix}${" ".repeat(
      4 * 1024 * 1024 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix),
    )}${suffix}`;
    expect(Buffer.byteLength(adversarial)).toBe(4 * 1024 * 1024);
    expectRejected(adversarial);

  });

  it.each([
    ["zero", "zeros", false],
    ["nonzero", "zeros-then-one", true],
    ["overflow", "sevens", undefined],
  ] as const)("parses an exact-4-MiB %s integer boolean", (
    name,
    pattern,
    expected,
  ) => {
    const checkout = join(root, `${name}-integer-checkout`);
    const metadata = join(root, `${name}-integer-metadata`);
    makeStandaloneMetadata(
      checkout,
      metadata,
      "[core]\nrepositoryformatversion = 0\n",
      false,
    );
    writeFileSync(
      join(metadata, "config.worktree"),
      `[core]\nworktree = ${checkout}\n`,
    );
    const configPath = join(metadata, "config");
    const prefix = "[extensions]worktreeConfig = ";
    const digitCount = 4 * 1024 * 1024 - Buffer.byteLength(prefix) - 1;
    const digits = pattern === "sevens"
      ? "7".repeat(digitCount)
      : `${"0".repeat(digitCount - 1)}${pattern === "zeros" ? "0" : "1"}`;
    const config = `${prefix}${digits}\n`;
    expect(Buffer.byteLength(config)).toBe(4 * 1024 * 1024);
    writeFileSync(configPath, config);

    if (expected === undefined) {
      expect(() => resolveGitProjectAnchor(checkout)).toThrow(
        "ambiguous worktree configuration",
      );
    } else if (expected) {
      expect(resolveGitProjectAnchor(checkout)?.canonical).toBe(checkout);
    } else {
      expect(() => resolveGitProjectAnchor(checkout)).toThrow(
        "expected one core.worktree path",
      );
    }
  });

  it("accepts a 174581-byte valid config with repeated branch metadata", () => {
    const primary = makeRepository(join(root, "large-config"));
    const linked = makeLinkedWorktree(primary, join(root, "large-config-linked"));
    const configPath = join(primary, ".git", "config");
    const config = repeatedBranchMetadataConfig(174_581);
    writeFileSync(configPath, config);

    expect(Buffer.byteLength(config)).toBe(174_581);
    const repeatedValues = git(
      primary,
      "config",
      "--file",
      configPath,
      "--get-all",
      "branch.main.github-pr-owner-number",
    ).split("\n");
    expect(repeatedValues.length).toBeGreaterThan(2_494);
    expect(new Set(repeatedValues)).toEqual(new Set(["123"]));
    expect(resolveGitProjectAnchor(primary)?.canonical).toBe(primary);
    expect(resolveGitProjectAnchor(linked)?.canonical).toBe(primary);
  });

  it("accepts 4 MiB Git configs and rejects either config location above the limit", () => {
    const primary = makeRepository(join(root, "config-boundary"));
    const configPath = join(primary, ".git", "config");
    const configPrefix = [
      "[core]",
      "repositoryformatversion = 0",
      "[extensions]",
      "worktreeConfig = true",
      "",
    ].join("\n");
    writeFileSync(configPath, padGitConfigToBytes(configPrefix, 4 * 1024 * 1024));
    expect(resolveGitProjectAnchor(primary)?.canonical).toBe(primary);

    writeFileSync(join(primary, ".git", "HEAD"), "h".repeat(64 * 1024));
    clearGitProjectAnchorCache();
    expect(resolveGitProjectAnchor(primary)?.canonical).toBe(primary);

    writeFileSync(configPath, padGitConfigToBytes(configPrefix, 4 * 1024 * 1024 + 1));
    clearGitProjectAnchorCache();
    expect(() => resolveGitProjectAnchor(primary)).toThrow(
      "invalid Git config metadata",
    );
    expect(() => resolveGitProjectAnchor(primary)).toThrow("size limit");

    writeFileSync(configPath, configPrefix);
    const metadata = makeDirectory(join(root, "configured-metadata"));
    makeDirectory(join(metadata, "objects"));
    writeFileSync(join(metadata, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(metadata, "config"), configPrefix);
    const checkout = makeDirectory(join(root, "configured-checkout"));
    writeFileSync(join(checkout, ".git"), "gitdir: ../configured-metadata\n");
    const worktreeConfigPath = join(metadata, "config.worktree");
    const worktreeConfigPrefix = `[core]\nworktree = ${checkout}\n`;
    writeFileSync(
      worktreeConfigPath,
      padGitConfigToBytes(worktreeConfigPrefix, 4 * 1024 * 1024),
    );
    clearGitProjectAnchorCache();
    expect(resolveGitProjectAnchor(checkout)?.canonical).toBe(checkout);

    writeFileSync(
      worktreeConfigPath,
      padGitConfigToBytes(worktreeConfigPrefix, 4 * 1024 * 1024 + 1),
    );
    clearGitProjectAnchorCache();
    expect(() => resolveGitProjectAnchor(checkout)).toThrow(
      "invalid Git worktree config metadata",
    );
    expect(() => resolveGitProjectAnchor(checkout)).toThrow("size limit");

    const pointerCheckout = join(root, "pointer-boundary-checkout");
    const pointerMetadata = join(root, "pointer-boundary-metadata");
    makeStandaloneMetadata(
      pointerCheckout,
      pointerMetadata,
      `[core]\nworktree = ${pointerCheckout}\n`,
    );
    const pointerSuffix = `${pointerMetadata}\n`;
    const pointerPrefix = "gitdir:";
    const exactPointer = `${pointerPrefix}${" ".repeat(
      64 * 1024
        - Buffer.byteLength(pointerPrefix)
        - Buffer.byteLength(pointerSuffix),
    )}${pointerSuffix}`;
    expect(Buffer.byteLength(exactPointer)).toBe(64 * 1024);
    writeFileSync(join(pointerCheckout, ".git"), exactPointer);
    clearGitProjectAnchorCache();
    expect(resolveGitProjectAnchor(pointerCheckout)?.canonical).toBe(
      pointerMetadata,
    );

    writeFileSync(join(pointerCheckout, ".git"), ` ${exactPointer}`);
    clearGitProjectAnchorCache();
    expect(() => resolveGitProjectAnchor(pointerCheckout)).toThrow("size limit");
  });

  it("rejects malformed, oversized, symlinked, and invalid Git metadata", () => {
    const malformed = makeDirectory(join(root, "malformed"));
    writeFileSync(join(malformed, ".git"), "not-a-gitdir\n");
    expect(() => resolveGitProjectAnchor(malformed)).toThrow("expected one gitdir line");

    const oversized = makeDirectory(join(root, "oversized"));
    writeFileSync(join(oversized, ".git"), `gitdir: ${"x".repeat(70 * 1024)}`);
    expect(() => resolveGitProjectAnchor(oversized)).toThrow("size limit");

    const target = makeDirectory(join(root, "target"));
    const symlinked = makeDirectory(join(root, "symlinked"));
    symlinkSync(target, join(symlinked, ".git"));
    expect(() => resolveGitProjectAnchor(symlinked)).toThrow("refusing symlink");

    const fifoLike = makeDirectory(join(root, "invalid-type"));
    const fifoPath = join(fifoLike, ".git");
    expect(spawnSync("mkfifo", [fifoPath]).status).toBe(0);
    expect(() => resolveGitProjectAnchor(fifoLike)).toThrow("invalid Git metadata type");
  });

  it("rejects unsafe common-directory metadata and non-directory targets", () => {
    const primary = makeRepository(join(root, "primary"));
    const linked = makeLinkedWorktree(primary, join(root, "linked"));
    const commonPointer = join(primary, ".git", "worktrees", "linked", "commondir");
    writeFileSync(commonPointer, "\n");
    clearGitProjectAnchorCache();
    expect(() => resolveGitProjectAnchor(linked)).toThrow("expected one path");

    writeFileSync(commonPointer, "../..\nextra\n");
    clearGitProjectAnchorCache();
    expect(() => resolveGitProjectAnchor(linked)).toThrow("expected one path");

    writeFileSync(commonPointer, "../..\0suffix");
    clearGitProjectAnchorCache();
    expect(() => resolveGitProjectAnchor(linked)).toThrow("expected one path");

    rmSync(commonPointer);
    symlinkSync(primary, commonPointer);
    clearGitProjectAnchorCache();
    expect(() => resolveGitProjectAnchor(linked)).toThrow("invalid Git common-directory");

    rmSync(commonPointer);
    makeDirectory(commonPointer);
    clearGitProjectAnchorCache();
    expect(() => resolveGitProjectAnchor(linked)).toThrow("invalid Git common-directory");

    const missingGitDir = makeDirectory(join(root, "missing-gitdir"));
    writeFileSync(join(missingGitDir, ".git"), "gitdir: nowhere\n");
    expect(() => resolveGitProjectAnchor(missingGitDir)).toThrow();

    const fileTarget = join(root, "file-target");
    writeFileSync(fileTarget, "file");
    const filePointer = makeDirectory(join(root, "file-pointer"));
    writeFileSync(join(filePointer, ".git"), `gitdir: ${fileTarget}\n`);
    expect(() => resolveGitProjectAnchor(filePointer)).toThrow("not a directory");

    expect(() => resolveGitProjectAnchor(fileTarget)).toThrow("working directory is not a directory");
  });

  it("requires regular HEAD/config metadata and a real objects directory", () => {
    const missingHead = makeRepository(join(root, "missing-head"));
    rmSync(join(missingHead, ".git", "HEAD"));
    expect(() => resolveGitProjectAnchor(missingHead)).toThrow("ENOENT");

    const directoryHead = makeRepository(join(root, "directory-head"));
    rmSync(join(directoryHead, ".git", "HEAD"));
    makeDirectory(join(directoryHead, ".git", "HEAD"));
    expect(() => resolveGitProjectAnchor(directoryHead)).toThrow("invalid Git HEAD");

    const linkedHead = makeRepository(join(root, "linked-head"));
    rmSync(join(linkedHead, ".git", "HEAD"));
    symlinkSync(join(linkedHead, ".git", "config"), join(linkedHead, ".git", "HEAD"));
    expect(() => resolveGitProjectAnchor(linkedHead)).toThrow("invalid Git HEAD");

    const oversizedHead = makeRepository(join(root, "oversized-head"));
    writeFileSync(join(oversizedHead, ".git", "HEAD"), "x".repeat(64 * 1024 + 1));
    expect(() => resolveGitProjectAnchor(oversizedHead)).toThrow("size limit");

    const linkedConfig = makeRepository(join(root, "linked-config"));
    rmSync(join(linkedConfig, ".git", "config"));
    symlinkSync(join(linkedConfig, ".git", "HEAD"), join(linkedConfig, ".git", "config"));
    expect(() => resolveGitProjectAnchor(linkedConfig)).toThrow("invalid Git config");

    const invalidObjects = makeRepository(join(root, "invalid-objects"));
    rmSync(join(invalidObjects, ".git", "objects"), { recursive: true });
    writeFileSync(join(invalidObjects, ".git", "objects"), "not a directory");
    expect(() => resolveGitProjectAnchor(invalidObjects)).toThrow("invalid Git objects");

    const symlinkObjects = makeRepository(join(root, "symlink-objects"));
    rmSync(join(symlinkObjects, ".git", "objects"), { recursive: true });
    symlinkSync(root, join(symlinkObjects, ".git", "objects"));
    expect(() => resolveGitProjectAnchor(symlinkObjects)).toThrow("invalid Git objects");
  });
});
