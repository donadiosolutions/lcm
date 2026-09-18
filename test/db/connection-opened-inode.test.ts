import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsState = vi.hoisted(() => ({
  targetPath: "",
  targetLstats: 0,
  actionsByLstat: new Map<number, () => void>(),
  beforeLeafResolve: undefined as (() => void) | undefined,
}));

const sqliteState = vi.hoisted(() => ({
  afterOpen: undefined as (() => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    realpathSync: Object.assign(
      (...args: Parameters<typeof actual.realpathSync>) => actual.realpathSync(...args),
      {
        native: (...args: Parameters<typeof actual.realpathSync.native>) => {
          if (String(args[0]) === fsState.targetPath) {
            const action = fsState.beforeLeafResolve;
            fsState.beforeLeafResolve = undefined;
            action?.();
          }
          return actual.realpathSync.native(...args);
        },
      },
    ),
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      const stat = actual.lstatSync(...args);
      if (String(args[0]) === fsState.targetPath) {
        fsState.targetLstats += 1;
        const action = fsState.actionsByLstat.get(fsState.targetLstats);
        if (action !== undefined) {
          fsState.actionsByLstat.delete(fsState.targetLstats);
          action();
        }
      }
      return stat;
    },
  };
});

vi.mock("node:sqlite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:sqlite")>();

  class HookedDatabaseSync extends actual.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
      super(...args);
      const action = sqliteState.afterOpen;
      if (action !== undefined) {
        sqliteState.afterOpen = undefined;
        action();
      }
    }
  }

  return { ...actual, DatabaseSync: HookedDatabaseSync };
});

import { DatabaseSync } from "node:sqlite";
import {
  closeLcmConnection,
  getExistingLcmConnection,
  getLcmConnection,
  isLcmConnectionOpen,
} from "../../src/db/connection.js";

const tempDirs: string[] = [];
const tempDescriptors: number[] = [];

function createMarkedDatabase(path: string, marker: string, journalMode = "WAL"): void {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = ${journalMode}`);
  db.exec("CREATE TABLE marker (value TEXT NOT NULL)");
  db.prepare("INSERT INTO marker VALUES (?)").run(marker);
  db.close();
}

function expectMarkerAndJournalMode(path: string, marker: string, journalMode: string): void {
  const db = new DatabaseSync(path);
  try {
    expect(db.prepare("SELECT value FROM marker").get()).toEqual({ value: marker });
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: journalMode });
  } finally {
    db.close();
  }
}

function createSubstitutionFixture(): Readonly<{
  dbPath: string;
  substitutePath: string;
  stashPath: string;
}> {
  const tempDir = mkdtempSync(join(tmpdir(), "lcm-opened-inode-test-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "authentic.sqlite");
  const substitutePath = join(tempDir, "substitute.sqlite");
  const stashPath = join(tempDir, "stash.sqlite");
  createMarkedDatabase(dbPath, "authentic");
  createMarkedDatabase(substitutePath, "substitute");
  for (const leaf of readdirSync(tempDir)) {
    if (leaf.endsWith("-wal") || leaf.endsWith("-shm")) unlinkSync(join(tempDir, leaf));
  }
  fsState.targetPath = dbPath;
  return { dbPath, substitutePath, stashPath };
}

afterEach(() => {
  closeLcmConnection();
  for (const descriptor of tempDescriptors.splice(0)) closeSync(descriptor);
  fsState.targetPath = "";
  fsState.targetLstats = 0;
  fsState.actionsByLstat.clear();
  fsState.beforeLeafResolve = undefined;
  sqliteState.afterOpen = undefined;
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("existing-only opened-inode authentication", () => {
  it("refuses a handle opened on a swapped-in inode restored before the path recheck", () => {
    const { dbPath, substitutePath, stashPath } = createSubstitutionFixture();
    fsState.actionsByLstat.set(1, () => {
      renameSync(dbPath, stashPath);
      renameSync(substitutePath, dbPath);
    });
    sqliteState.afterOpen = () => {
      renameSync(dbPath, substitutePath);
      renameSync(stashPath, dbPath);
    };

    expect(() => getExistingLcmConnection(dbPath))
      .toThrow("database handle is not bound to the authenticated database file");
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
  });

  it("refuses a handle whose authenticated leaf is replaced after the path recheck", () => {
    const { dbPath, substitutePath, stashPath } = createSubstitutionFixture();
    fsState.actionsByLstat.set(1, () => {
      renameSync(dbPath, stashPath);
      renameSync(substitutePath, dbPath);
    });
    sqliteState.afterOpen = () => {
      renameSync(dbPath, substitutePath);
      renameSync(stashPath, dbPath);
    };
    fsState.actionsByLstat.set(2, () => {
      renameSync(dbPath, stashPath);
      renameSync(substitutePath, dbPath);
    });

    expect(() => getExistingLcmConnection(dbPath))
      .toThrow("database handle is not bound to the authenticated database file");
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
  });

  it("opens an unsubstituted database and binds the pooled handle to its inode", () => {
    const { dbPath } = createSubstitutionFixture();

    const db = getExistingLcmConnection(dbPath);

    expect(db).not.toBeNull();
    expect(db!.prepare("SELECT value FROM marker").get()).toEqual({ value: "authentic" });
    expect(isLcmConnectionOpen(dbPath)).toBe(true);
  });

  it("keeps pathname evidence when the descriptor namespace is unavailable", () => {
    const { dbPath } = createSubstitutionFixture();

    const db = getExistingLcmConnection(dbPath, {
      _descriptorsForTesting: {
        readdir: () => {
          throw Object.assign(new Error("injected ENOENT"), { code: "ENOENT" });
        },
      },
    });

    expect(db).not.toBeNull();
    expect(db!.prepare("SELECT value FROM marker").get()).toEqual({ value: "authentic" });
    expect(isLcmConnectionOpen(dbPath)).toBe(true);
  });

  it("refuses when the descriptor namespace disappears before the handle is proven", () => {
    const { dbPath } = createSubstitutionFixture();
    let listings = 0;

    expect(() => getExistingLcmConnection(dbPath, {
      _descriptorsForTesting: {
        readdir: (path: string) => {
          listings += 1;
          if (listings > 1) {
            throw Object.assign(new Error("injected ENOENT"), { code: "ENOENT" });
          }
          return readdirSync(path);
        },
      },
    })).toThrow("database handle is not bound to the authenticated database file");
    expect(listings).toBe(2);
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
  });
});

type DescriptorSnapshot = readonly Readonly<{
  fd: number;
  link: string;
  dev: bigint;
  ino: bigint;
  mode?: bigint;
}>[];

function snapshotOperations(snapshots: readonly DescriptorSnapshot[]) {
  let taken = -1;
  const current = (): DescriptorSnapshot => snapshots[Math.min(taken, snapshots.length - 1)]!;
  const find = (path: string) => {
    const fd = Number(path.slice("/proc/self/fd/".length));
    const descriptor = current().find(entry => entry.fd === fd);
    if (descriptor === undefined) {
      throw Object.assign(new Error("injected ENOENT"), { code: "ENOENT" });
    }
    return descriptor;
  };
  return {
    readdir: () => {
      taken += 1;
      return current().map(descriptor => String(descriptor.fd));
    },
    readlink: (path: string) => find(path).link,
    stat: (path: string) => {
      const descriptor = find(path);
      const mode = descriptor.mode ?? 0o100600n;
      return {
        isDirectory: () => (mode & 0o170000n) === 0o040000n,
        mode,
        uid: 0n,
        gid: 0n,
        nlink: 1n,
        dev: descriptor.dev,
        ino: descriptor.ino,
      };
    },
  };
}

function authenticIdentity(path: string): Readonly<{ dev: bigint; ino: bigint }> {
  const stat = lstatSync(path, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
}

describe("opened-inode descriptor admission", () => {
  it("admits an open that SQLite satisfied from a descriptor it already retained", () => {
    const { dbPath } = createSubstitutionFixture();
    const authentic = authenticIdentity(dbPath);
    const retained: DescriptorSnapshot = [{ fd: 20, link: dbPath, ...authentic }];

    const db = getExistingLcmConnection(dbPath, {
      _descriptorsForTesting: snapshotOperations([retained, retained]),
    });

    expect(db!.prepare("SELECT value FROM marker").get()).toEqual({ value: "authentic" });
    expect(isLcmConnectionOpen(dbPath)).toBe(true);
  });

  it.each([
    [
      "a descriptor that is not a regular file",
      (dbPath: string, authentic: Readonly<{ dev: bigint; ino: bigint }>): DescriptorSnapshot => [
        { fd: 20, link: dbPath, ...authentic },
        { fd: 21, link: "socket:[992]", dev: 0n, ino: 992n, mode: 0o140777n },
      ],
    ],
    [
      "a second descriptor naming the authenticated database",
      (dbPath: string, authentic: Readonly<{ dev: bigint; ino: bigint }>): DescriptorSnapshot => [
        { fd: 20, link: dbPath, ...authentic },
        { fd: 21, link: dbPath, ...authentic },
      ],
    ],
  ])("admits an open that also retained %s", (_label, after) => {
    const { dbPath } = createSubstitutionFixture();
    const authentic = authenticIdentity(dbPath);

    const db = getExistingLcmConnection(dbPath, {
      _descriptorsForTesting: snapshotOperations([
        [{ fd: 20, link: dbPath, ...authentic }],
        after(dbPath, authentic),
      ]),
    });

    expect(db!.prepare("SELECT value FROM marker").get()).toEqual({ value: "authentic" });
    expect(isLcmConnectionOpen(dbPath)).toBe(true);
  });

  it("admits an unrelated regular file the process already held open", () => {
    const { dbPath, substitutePath } = createSubstitutionFixture();
    const authentic = authenticIdentity(dbPath);
    const unrelated = { fd: 21, link: substitutePath, ...authenticIdentity(substitutePath) };

    const db = getExistingLcmConnection(dbPath, {
      _descriptorsForTesting: snapshotOperations([
        [{ fd: 20, link: dbPath, ...authentic }, unrelated],
        [{ fd: 20, link: dbPath, ...authentic }, unrelated],
      ]),
    });

    expect(db!.prepare("SELECT value FROM marker").get()).toEqual({ value: "authentic" });
    expect(isLcmConnectionOpen(dbPath)).toBe(true);
  });

  it.each([
    [
      "the open retained a foreign regular file",
      (dbPath: string, substitutePath: string, authentic: Readonly<{ dev: bigint; ino: bigint }>):
        DescriptorSnapshot => [
          { fd: 20, link: dbPath, ...authentic },
          { fd: 21, link: `${dbPath}-journal`, dev: authentic.dev, ino: authentic.ino + 7n },
        ],
    ],
    [
      "a descriptor naming the database holds another inode",
      (dbPath: string, _substitutePath: string, authentic: Readonly<{ dev: bigint; ino: bigint }>):
        DescriptorSnapshot => [
          { fd: 20, link: dbPath, dev: authentic.dev, ino: authentic.ino + 7n },
        ],
    ],
    [
      "no descriptor names the database",
      (): DescriptorSnapshot => [],
    ],
    [
      "a descriptor number reused by the open now names another file",
      (dbPath: string, substitutePath: string, authentic: Readonly<{ dev: bigint; ino: bigint }>):
        DescriptorSnapshot => [
          { fd: 20, link: dbPath, ...authentic },
          { fd: 21, link: substitutePath, dev: authentic.dev, ino: authentic.ino + 7n },
        ],
    ],
    [
      "a descriptor number reused by the open holds another inode at the same name",
      (_dbPath: string, _substitutePath: string, authentic: Readonly<{ dev: bigint; ino: bigint }>):
        DescriptorSnapshot => [
          { fd: 20, link: _dbPath, ...authentic },
          { fd: 21, link: "/var/tmp/pad.bin", dev: authentic.dev, ino: authentic.ino + 7n },
        ],
    ],
    [
      "a foreign regular file is retained beside a newly opened database descriptor",
      (dbPath: string, substitutePath: string, authentic: Readonly<{ dev: bigint; ino: bigint }>):
        DescriptorSnapshot => [
          { fd: 20, link: dbPath, ...authentic },
          { fd: 22, link: dbPath, ...authentic },
          { fd: 23, link: substitutePath, dev: authentic.dev, ino: authentic.ino + 9n },
        ],
    ],
  ])("refuses when %s", (_label, after) => {
    const { dbPath, substitutePath } = createSubstitutionFixture();
    const authentic = authenticIdentity(dbPath);

    expect(() => getExistingLcmConnection(dbPath, {
      _descriptorsForTesting: snapshotOperations([
        [
          { fd: 20, link: dbPath, ...authentic },
          { fd: 21, link: "/var/tmp/pad.bin", dev: authentic.dev, ino: authentic.ino + 21n },
        ],
        after(dbPath, substitutePath, authentic),
      ]),
    })).toThrow("database handle is not bound to the authenticated database file");
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
  });

  it("propagates a descriptor failure that is not a capability refusal", () => {
    const { dbPath } = createSubstitutionFixture();

    expect(() => getExistingLcmConnection(dbPath, {
      _descriptorsForTesting: {
        readlink: () => {
          throw Object.assign(new Error("injected EACCES"), { code: "EACCES" });
        },
      },
    })).toThrow("injected EACCES");
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
  });

  it("propagates a descriptor failure raised only after the handle is open", () => {
    const { dbPath } = createSubstitutionFixture();
    let listings = 0;

    expect(() => getExistingLcmConnection(dbPath, {
      _descriptorsForTesting: {
        readdir: (path: string) => {
          listings += 1;
          return readdirSync(path);
        },
        readlink: (path: string) => {
          if (listings > 1) {
            throw Object.assign(new Error("injected EACCES"), { code: "EACCES" });
          }
          return readlinkSync(path);
        },
      },
    })).toThrow("injected EACCES");
    expect(listings).toBe(2);
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
  });

  it("refuses a substitution before changing permissions or running pragmas", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-opened-inode-ordering-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "authentic.sqlite");
    const substitutePath = join(tempDir, "substitute.sqlite");
    const stashPath = join(tempDir, "stash.sqlite");
    createMarkedDatabase(dbPath, "authentic");
    // A rollback-journal substitute proves the WAL pragma never reached the
    // substituted handle: running it would persist "wal" in that file.
    createMarkedDatabase(substitutePath, "substitute", "DELETE");
    for (const leaf of readdirSync(tempDir)) {
      if (leaf.endsWith("-wal") || leaf.endsWith("-shm")) unlinkSync(join(tempDir, leaf));
    }
    fsState.targetPath = dbPath;
    chmodSync(dbPath, 0o644);
    chmodSync(substitutePath, 0o644);
    fsState.actionsByLstat.set(1, () => {
      renameSync(dbPath, stashPath);
      renameSync(substitutePath, dbPath);
    });
    sqliteState.afterOpen = () => {
      renameSync(dbPath, substitutePath);
      renameSync(stashPath, dbPath);
    };

    expect(() => getExistingLcmConnection(dbPath))
      .toThrow("database handle is not bound to the authenticated database file");

    expect(statSync(dbPath).mode & 0o777).toBe(0o644);
    expect(statSync(substitutePath).mode & 0o777).toBe(0o644);
    expectMarkerAndJournalMode(dbPath, "authentic", "wal");
    expectMarkerAndJournalMode(substitutePath, "substitute", "delete");
  });

  it("creates and binds a missing database in create-capable mode", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-opened-inode-create-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "created.sqlite");
    fsState.targetPath = dbPath;

    const db = getLcmConnection(dbPath);

    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(isLcmConnectionOpen(dbPath)).toBe(true);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
  });
});

describe("opened-inode substitution parked under a database sidecar name", () => {
  it("refuses a restored substitution parked at the rollback journal name", () => {
    const { dbPath, substitutePath, stashPath } = createSubstitutionFixture();
    const journalPath = `${dbPath}-journal`;
    // A descriptor the process already holds on the authentic database, which is
    // an ordinary condition: reconciliation flows hold several while opening.
    const retainedFd = openSync(dbPath, "r+");
    tempDescriptors.push(retainedFd);
    fsState.actionsByLstat.set(1, () => {
      renameSync(dbPath, stashPath);
      renameSync(substitutePath, dbPath);
    });
    sqliteState.afterOpen = () => {
      // Park the substituted database under a name WAL mode never reclaims, so
      // the handle keeps reading it while the authenticated leaf is restored.
      renameSync(dbPath, journalPath);
      renameSync(stashPath, dbPath);
    };

    expect(() => getExistingLcmConnection(dbPath))
      .toThrow("database handle is not bound to the authenticated database file");
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
    expectMarkerAndJournalMode(dbPath, "authentic", "wal");
    // The refusal precedes the permission change, so the authenticated leaf
    // keeps the mode the fixture created it with.
    expect(statSync(dbPath).mode & 0o777).toBe(0o644);
  });
});

describe("opened-inode substitution on a recycled descriptor number", () => {
  it("refuses a restored substitution that reuses a descriptor freed after the listing", () => {
    const { dbPath, substitutePath, stashPath } = createSubstitutionFixture();
    const padPath = join(dirname(dbPath), "pad.bin");
    writeFileSync(padPath, "pad");
    // An authentic descriptor the process already holds, and a second descriptor
    // that is live when the pre-open listing runs but is closed before the
    // constructor, freeing its number for SQLite to reuse.
    const retainedFd = openSync(dbPath, "r+");
    tempDescriptors.push(retainedFd);
    const padFd = openSync(padPath, "r+");
    fsState.actionsByLstat.set(1, () => {
      renameSync(dbPath, stashPath);
      renameSync(substitutePath, dbPath);
    });
    fsState.beforeLeafResolve = () => closeSync(padFd);
    sqliteState.afterOpen = () => {
      renameSync(dbPath, substitutePath);
      renameSync(stashPath, dbPath);
    };

    expect(() => getExistingLcmConnection(dbPath))
      .toThrow("database handle is not bound to the authenticated database file");
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
    expectMarkerAndJournalMode(dbPath, "authentic", "wal");
  });
});

describe("opened-inode substitution laundered by a concurrent database open", () => {
  it("refuses a restored substitution even when the database is reopened in the window", () => {
    const { dbPath, substitutePath, stashPath } = createSubstitutionFixture();
    const retainedFd = openSync(dbPath, "r+");
    tempDescriptors.push(retainedFd);
    fsState.actionsByLstat.set(1, () => {
      renameSync(dbPath, stashPath);
      renameSync(substitutePath, dbPath);
    });
    sqliteState.afterOpen = () => {
      renameSync(dbPath, substitutePath);
      renameSync(stashPath, dbPath);
      // Unrelated work in this process reopens the authenticated database on a
      // new descriptor. It must not stand in as evidence for another handle.
      tempDescriptors.push(openSync(dbPath, "r+"));
    };

    expect(() => getExistingLcmConnection(dbPath))
      .toThrow("database handle is not bound to the authenticated database file");
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
    expectMarkerAndJournalMode(dbPath, "authentic", "wal");
  });
});
