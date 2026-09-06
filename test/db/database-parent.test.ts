import {
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitDatabaseParent } from "../../src/db/database-parent.js";

function errno(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function overrideStat(
  stat: BigIntStats,
  overrides: Partial<Record<keyof BigIntStats, unknown>>,
): BigIntStats {
  return new Proxy(stat, {
    get(target, property, receiver) {
      if (property in overrides) return overrides[property as keyof BigIntStats];
      return Reflect.get(target, property, receiver);
    },
  });
}

describe("database parent admission failure boundaries", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function tempDirectory(prefix: string): string {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(directory);
    return directory;
  }

  it("rejects a descriptor that is not a directory", () => {
    const directory = tempDirectory("lcm-db-parent-descriptor-file-");
    const file = join(directory, "file");
    writeFileSync(file, "preserve");

    expect(() => admitDatabaseParent(join(directory, "events.sqlite"), {
      createIfMissing: true,
      tighten: true,
      _databaseParentForTesting: {
        open: () => openSync(file, constants.O_RDONLY),
      },
    })).toThrow("descriptor is not a directory");
  });

  it.each([
    null,
    "plain open failure",
    {},
    { code: 7 },
  ])("normalizes a non-errno descriptor-open failure (%j)", (failure) => {
    const directory = tempDirectory("lcm-db-parent-open-error-shape-");

    expect(() => admitDatabaseParent(join(directory, "events.sqlite"), {
      createIfMissing: true,
      tighten: true,
      _databaseParentForTesting: { open: () => { throw failure; } },
    })).toThrow("database parent topology is not trusted");
  });

  it("normalizes a non-Error authentication failure", () => {
    const directory = tempDirectory("lcm-db-parent-stat-error-shape-");

    expect(() => admitDatabaseParent(join(directory, "events.sqlite"), {
      createIfMissing: true,
      tighten: true,
      _databaseParentForTesting: {
        fstat: () => { throw "plain fstat failure"; },
      },
    })).toThrow("plain fstat failure");
  });

  it("rejects a final entry reported as a symlink", () => {
    const directory = tempDirectory("lcm-db-parent-entry-symlink-");

    expect(() => admitDatabaseParent(join(directory, "events.sqlite"), {
      createIfMissing: true,
      tighten: true,
      _databaseParentForTesting: {
        lstat: (path) => overrideStat(lstatSync(path, { bigint: true }), {
          isDirectory: () => true,
          isSymbolicLink: () => true,
        }),
      },
    })).toThrow("entry is not a directory");
  });

  it("rejects a final entry whose owner differs from the descriptor", () => {
    const directory = tempDirectory("lcm-db-parent-entry-owner-");

    expect(() => admitDatabaseParent(join(directory, "events.sqlite"), {
      createIfMissing: true,
      tighten: true,
      _databaseParentForTesting: {
        lstat: (path) => {
          const stat = lstatSync(path, { bigint: true });
          return overrideStat(stat, { uid: stat.uid + 1n });
        },
      },
    })).toThrow("entry owner is not trusted");
  });

  it("rejects an invalid expected owner identifier", () => {
    const directory = tempDirectory("lcm-db-parent-invalid-owner-");

    expect(() => admitDatabaseParent(join(directory, "events.sqlite"), {
      createIfMissing: true,
      tighten: true,
      _databaseParentForTesting: { expectedUid: Number.NaN },
    })).toThrow("owner is not trusted");
  });

  it("supports platforms without numeric user ownership", () => {
    const directory = tempDirectory("lcm-db-parent-no-owner-");
    const handle = admitDatabaseParent(join(directory, "events.sqlite"), {
      createIfMissing: true,
      tighten: true,
      _databaseParentForTesting: { expectedUid: null },
    });

    expect(handle).not.toBeNull();
    handle?.close();
    handle?.close();
  });

  it("derives no owner requirement when the platform has no getuid", () => {
    const directory = tempDirectory("lcm-db-parent-platform-no-getuid-");
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", {
      configurable: true,
      value: undefined,
    });
    try {
      const handle = admitDatabaseParent(join(directory, "events.sqlite"), {
        createIfMissing: true,
        tighten: true,
      });
      expect(handle).not.toBeNull();
      handle?.close();
    } finally {
      if (descriptor) Object.defineProperty(process, "getuid", descriptor);
      else delete (process as Partial<NodeJS.Process>).getuid;
    }
  });

  it("checks both descriptor and entry modes after tightening", () => {
    const descriptorDirectory = tempDirectory("lcm-db-parent-descriptor-mode-");
    chmodSync(descriptorDirectory, 0o755);
    expect(() => admitDatabaseParent(join(descriptorDirectory, "events.sqlite"), {
      createIfMissing: true,
      tighten: true,
      _databaseParentForTesting: { fchmod: () => undefined },
    })).toThrow("mode is not private");

    const entryDirectory = tempDirectory("lcm-db-parent-entry-mode-");
    expect(() => admitDatabaseParent(join(entryDirectory, "events.sqlite"), {
      createIfMissing: true,
      tighten: true,
      _databaseParentForTesting: {
        lstat: (path) => overrideStat(lstatSync(path, { bigint: true }), {
          mode: 0o40755n,
        }),
      },
    })).toThrow("mode is not private");
  });

  it("admits a parent that appears after the initial absence check", () => {
    const directory = tempDirectory("lcm-db-parent-appeared-");
    const parent = join(directory, "parent");
    let opens = 0;
    const handle = admitDatabaseParent(join(parent, "events.sqlite"), {
      createIfMissing: true,
      tighten: true,
      _databaseParentForTesting: {
        open: (path, flags) => {
          opens += 1;
          if (opens === 1) {
            mkdirSync(parent, { mode: 0o755 });
            throw errno("initially absent", "ENOENT");
          }
          return openSync(path, flags);
        },
      },
    });

    expect(handle).not.toBeNull();
    handle?.close();
    expect(statSync(parent).mode & 0o777).toBe(0o700);
  });

  it("rejects a parent that disappears again after appearing", () => {
    const directory = tempDirectory("lcm-db-parent-disappeared-");
    const parent = join(directory, "parent");
    let opens = 0;

    expect(() => admitDatabaseParent(join(parent, "events.sqlite"), {
      createIfMissing: true,
      tighten: true,
      _databaseParentForTesting: {
        open: () => {
          opens += 1;
          if (opens === 1) mkdirSync(parent, { mode: 0o700 });
          throw errno("missing", "ENOENT");
        },
      },
    })).toThrow("disappeared before admission");
  });

  it("rejects failure while locating the existing creation anchor", () => {
    const directory = tempDirectory("lcm-db-parent-anchor-failure-");
    const parent = join(directory, "parent");

    expect(() => admitDatabaseParent(join(parent, "events.sqlite"), {
      createIfMissing: true,
      tighten: true,
      _databaseParentForTesting: {
        open: () => { throw errno("missing", "ENOENT"); },
        lstat: () => { throw errno("denied", "EACCES"); },
      },
    })).toThrow("denied");
  });

  it("rejects a creation path with no observable existing anchor", () => {
    const directory = tempDirectory("lcm-db-parent-no-anchor-");
    const parent = join(directory, "parent");

    expect(() => admitDatabaseParent(join(parent, "events.sqlite"), {
      createIfMissing: true,
      tighten: true,
      _databaseParentForTesting: {
        open: () => { throw errno("missing", "ENOENT"); },
        lstat: () => { throw errno("missing", "ENOENT"); },
      },
    })).toThrow("no existing ancestor");
  });

  it("propagates a component creation failure", () => {
    const directory = tempDirectory("lcm-db-parent-mkdir-failure-");
    const parent = join(directory, "parent");

    expect(() => admitDatabaseParent(join(parent, "events.sqlite"), {
      createIfMissing: true,
      tighten: true,
      _databaseParentForTesting: {
        mkdir: () => { throw errno("mkdir denied", "EACCES"); },
      },
    })).toThrow("mkdir denied");
  });

  it("rejects a created component that disappears before admission", () => {
    const directory = tempDirectory("lcm-db-parent-created-disappeared-");
    const parent = join(directory, "parent");
    let opens = 0;

    expect(() => admitDatabaseParent(join(parent, "events.sqlite"), {
      createIfMissing: true,
      tighten: true,
      _databaseParentForTesting: {
        open: (path, flags) => {
          opens += 1;
          if (opens <= 2) throw errno("missing", "ENOENT");
          return openSync(path, flags);
        },
      },
    })).toThrow("created entry disappeared");
  });

  it("rejects an immediate symlink parent while allowing higher aliases", () => {
    const directory = tempDirectory("lcm-db-parent-direct-symlink-");
    const target = join(directory, "target");
    const parent = join(directory, "parent");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, parent);

    expect(() => admitDatabaseParent(join(parent, "events.sqlite"), {
      createIfMissing: false,
      tighten: false,
    })).toThrow("topology");
  });
});
