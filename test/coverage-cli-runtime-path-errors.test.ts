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
  fstatHook: undefined as ((path: string, stat: unknown) => unknown) | undefined,
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

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    constants: {
      ...actual.constants,
      O_DIRECTORY: undefined,
      O_NOFOLLOW: undefined,
      O_NONBLOCK: undefined,
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
  fsControl.fstatHook = undefined;
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

function copyingJournal(home: string, source: string, staging: string): void {
  const operationId = "0123456789abcdef0123456789abcdef0123456789abcdef";
  const stagingName = basename(staging);
  const sourceWitness = treeWitness(source);
  const targetWitness = treeWitness(staging);
  const payload = {
    version: 1,
    phase: "copying",
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

describe("runtime home rename failures", () => {
  it("falls back to copy-and-remove for cross-device renames", () => {
    const paths = legacyHome();
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    expect(migrateLegacyHomeIfNeeded(paths.home)).toEqual({
      migrated: true,
      from: paths.legacy,
      to: paths.next,
    });
    expect(readFileSync(join(paths.next, "value.txt"), "utf-8")).toBe("value");
    expect(existsSync(paths.legacy)).toBe(false);
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
    expect(existsSync(paths.legacy)).toBe(false);
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
    let rootFstats = 0;
    fsControl.fstatHook = (path, stat) => {
      if (path === lcmHomeDir(home) && [8, 9].includes(++rootFstats)) {
        const currentMode = (stat as { mode: bigint }).mode;
        return Object.assign(stat as object, {
          mode: (currentMode & ~0o7777n) | 0o755n,
        });
      }
      return stat;
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

    expect(() => bootstrapLcmHome(home)).toThrow("already in progress");
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
      if (path === valuePath && calls++ === 0) {
        return { ...(stat as object), ino: (stat as { ino: bigint }).ino + 1n };
      }
      return stat;
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("entry changed before descriptor validation");
  });

  it("rejects an entry whose descriptor changes after validation", () => {
    const paths = legacyHome();
    const valuePath = join(paths.legacy, "value.txt");
    let calls = 0;
    fsControl.fstatHook = (path, stat) => {
      if (path === valuePath && calls++ === 1) {
        return { ...(stat as object), mtimeNs: (stat as { mtimeNs: bigint }).mtimeNs + 1n };
      }
      return stat;
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("legacy migration descriptor changed");
  });

  it("rejects an invalid directory entry name during witness construction", () => {
    const paths = legacyHome();
    fsControl.readdirHook = (path, options) => {
      if (path === paths.legacy && (options as { withFileTypes?: boolean } | undefined)?.withFileTypes) {
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
      if (!mutated && path === paths.legacy && options === undefined) {
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
      if (path === valuePath && calls++ === 4) {
        return { ...(stat as object), ino: (stat as { ino: bigint }).ino + 1n };
      }
      return stat;
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("source changed before copy");
  });

  it("rejects a source directory that changes before the copy walk", () => {
    const paths = legacyHome();
    let calls = 0;
    fsControl.fstatHook = (path, stat) => {
      if (path === paths.legacy && calls++ === 4) {
        return { ...(stat as object), ino: (stat as { ino: bigint }).ino + 1n };
      }
      return stat;
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("directory changed before copy");
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
      if (path === paths.legacy && options === undefined && ++noOptionReads === 3) {
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
    expect(existsSync(join(paths.home, ".lcm-legacy-migration.json"))).toBe(false);
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

  it("rejects a source root that changes before exact removal", () => {
    const paths = legacyHome();
    let armed = false;
    fsControl.writeHook = (_path, _fd, content) => {
      if (content.toString().includes('"phase":"removing"')) armed = true;
    };
    fsControl.lstatHook = (path, stat) => {
      if (armed && path === paths.legacy) {
        armed = false;
        return Object.assign(stat as object, { ino: (stat as { ino: bigint }).ino + 1n });
      }
      return stat;
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("removal target changed");
  });

  it("rejects a source root whose removal descriptor changes", () => {
    const paths = legacyHome();
    let armed = false;
    fsControl.writeHook = (_path, _fd, content) => {
      if (content.toString().includes('"phase":"removing"')) armed = true;
    };
    fsControl.fstatHook = (path, stat) => {
      if (armed && path === paths.legacy) {
        armed = false;
        return { ...(stat as object), ino: (stat as { ino: bigint }).ino + 1n };
      }
      return stat;
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("removal target changed");
  });

  it("rejects a source file whose removal descriptor changes", () => {
    const paths = legacyHome();
    const valuePath = join(paths.legacy, "value.txt");
    let armed = false;
    fsControl.writeHook = (_path, _fd, content) => {
      if (content.toString().includes('"phase":"removing"')) armed = true;
    };
    fsControl.fstatHook = (path, stat) => {
      if (armed && path === valuePath) {
        armed = false;
        return { ...(stat as object), ino: (stat as { ino: bigint }).ino + 1n };
      }
      return stat;
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("file changed during removal");
  });

  it("rejects a source file that changes before its unlink", () => {
    const paths = legacyHome();
    const valuePath = join(paths.legacy, "value.txt");
    let armed = false;
    let childLstats = 0;
    fsControl.writeHook = (_path, _fd, content) => {
      if (content.toString().includes('"phase":"removing"')) armed = true;
    };
    fsControl.lstatHook = (path, stat) => {
      if (armed && path === valuePath && ++childLstats === 2) {
        armed = false;
        return { ...(stat as object), ino: (stat as { ino: bigint }).ino + 1n };
      }
      return stat;
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("file changed during removal");
  });

  it("rejects a symlink that appears during exact source removal", () => {
    const paths = legacyHome();
    let armed = false;
    fsControl.writeHook = (_path, _fd, content) => {
      if (content.toString().includes('"phase":"removing"')) armed = true;
    };
    fsControl.readdirHook = (path, options, entries) => {
      if (armed && path === paths.legacy && options === undefined) {
        armed = false;
        symlinkSync(join(paths.home, "outside"), join(paths.legacy, "0-link"));
        return [...(entries as string[]), "0-link"];
      }
      return entries;
    };
    writeFileSync(join(paths.home, "outside"), "outside");

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("symlink entry appeared");
  });

  it("rejects an unsupported entry that appears during exact source removal", () => {
    const paths = legacyHome();
    let armed = false;
    fsControl.writeHook = (_path, _fd, content) => {
      if (content.toString().includes('"phase":"removing"')) armed = true;
    };
    fsControl.readdirHook = (path, options, entries) => {
      if (armed && path === paths.legacy && options === undefined) {
        armed = false;
        const result = spawnSync("mkfifo", [join(paths.legacy, "0-pipe")], { encoding: "utf-8" });
        if (result.status !== 0) throw new Error(`mkfifo failed: ${result.stderr}`);
        return [...(entries as string[]), "0-pipe"];
      }
      return entries;
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("unsupported removal entry");
  });

  it("rejects a source directory that changes after an unlink", () => {
    const paths = legacyHome();
    let armed = false;
    fsControl.writeHook = (_path, _fd, content) => {
      if (content.toString().includes('"phase":"removing"')) armed = true;
    };
    fsControl.unlinkHook = (path) => {
      if (armed && path === join(paths.legacy, "value.txt")) {
        armed = false;
        writeFileSync(join(paths.legacy, "late-entry"), "late", { mode: 0o600 });
      }
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("directory changed during removal");
  });
});
