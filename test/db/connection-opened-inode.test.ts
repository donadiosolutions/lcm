import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readdirSync,
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
  beforeOpen: undefined as (() => void) | undefined,
  afterOpen: undefined as (() => void) | undefined,
}));

const fdState = vi.hoisted(() => ({
  leafDescriptor: undefined as number | undefined,
  failLeafClose: false,
  failLeafCreate: false,
  loseLeafCreateRace: false,
  starveLeafCreate: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (fdState.failLeafCreate && String(args[0]) === fsState.targetPath) {
        fdState.failLeafCreate = false;
        throw Object.assign(new Error("injected leaf creation failure"), { code: "EACCES" });
      }
      if (fdState.loseLeafCreateRace && String(args[0]) === fsState.targetPath) {
        fdState.loseLeafCreateRace = false;
        // Another writer creates the database first, so the exclusive create
        // below fails with EEXIST exactly as it would under a real race.
        actual.closeSync(actual.openSync(
          args[0],
          actual.constants.O_RDWR | actual.constants.O_CREAT | actual.constants.O_EXCL,
          0o600,
        ));
      }
      if (fdState.starveLeafCreate > 0 && String(args[0]) === fsState.targetPath
        && (Number(args[1]) & actual.constants.O_CREAT) !== 0) {
        // The exclusive create keeps losing to a writer whose database is gone
        // again by the time the fallback inspection runs.
        fdState.starveLeafCreate -= 1;
        throw Object.assign(new Error("injected EEXIST"), { code: "EEXIST" });
      }
      const fd = actual.openSync(...args);
      if (String(args[0]) === fsState.targetPath) fdState.leafDescriptor = fd;
      return fd;
    },
    closeSync: (fd: number) => {
      if (fdState.failLeafClose && fd === fdState.leafDescriptor) {
        fdState.failLeafClose = false;
        actual.closeSync(fd);
        throw Object.assign(new Error("injected retained leaf close failure"), { code: "EIO" });
      }
      actual.closeSync(fd);
    },
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
      const before = sqliteState.beforeOpen;
      if (before !== undefined) {
        sqliteState.beforeOpen = undefined;
        before();
      }
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

const BINDING_ERROR = "database handle is not bound to the authenticated database file";

const tempDirs: string[] = [];
const tempDescriptors: number[] = [];

function createMarkedDatabase(path: string, marker: string, journalMode = "WAL"): void {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = ${journalMode}`);
  db.exec("CREATE TABLE marker (value TEXT NOT NULL)");
  db.prepare("INSERT INTO marker VALUES (?)").run(marker);
  db.close();
}

function expectMarker(path: string, marker: string): void {
  const db = new DatabaseSync(path);
  try {
    expect(db.prepare("SELECT value FROM marker").get()).toEqual({ value: marker });
  } finally {
    db.close();
  }
}

type SubstitutionFixture = Readonly<{
  dbPath: string;
  substitutePath: string;
  stashPath: string;
  swap: () => void;
  restore: () => void;
  settle: () => void;
}>;

function createSubstitutionFixture(substituteJournalMode = "WAL"): SubstitutionFixture {
  const tempDir = mkdtempSync(join(tmpdir(), "lcm-opened-inode-test-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "authentic.sqlite");
  const substitutePath = join(tempDir, "substitute.sqlite");
  const stashPath = join(tempDir, "stash.sqlite");
  createMarkedDatabase(dbPath, "authentic");
  createMarkedDatabase(substitutePath, "substitute", substituteJournalMode);
  for (const leaf of readdirSync(tempDir)) {
    if (leaf.endsWith("-wal") || leaf.endsWith("-shm")) unlinkSync(join(tempDir, leaf));
  }
  fsState.targetPath = dbPath;
  const swap = (): void => {
    renameSync(dbPath, stashPath);
    renameSync(substitutePath, dbPath);
  };
  const restore = (): void => {
    renameSync(dbPath, substitutePath);
    renameSync(stashPath, dbPath);
  };
  // A refusal can land before or after the attack's own restore step, so the
  // assertions settle the fixture rather than assuming which one ran.
  const settle = (): void => {
    // Disarm the hooks first: assertions open databases too, and a stale hook
    // would replay the attack against the assertion's own handle.
    fsState.beforeLeafResolve = undefined;
    fsState.actionsByLstat.clear();
    sqliteState.beforeOpen = undefined;
    sqliteState.afterOpen = undefined;
    if (existsSync(stashPath)) restore();
  };
  return { dbPath, substitutePath, stashPath, swap, restore, settle };
}

afterEach(() => {
  closeLcmConnection();
  for (const descriptor of tempDescriptors.splice(0)) {
    try {
      closeSync(descriptor);
    } catch {
      // The test closed it deliberately as part of the attack it reproduced.
    }
  }
  fsState.targetPath = "";
  fsState.targetLstats = 0;
  fsState.actionsByLstat.clear();
  fsState.beforeLeafResolve = undefined;
  sqliteState.beforeOpen = undefined;
  sqliteState.afterOpen = undefined;
  fdState.leafDescriptor = undefined;
  fdState.failLeafClose = false;
  fdState.failLeafCreate = false;
  fdState.loseLeafCreateRace = false;
  fdState.starveLeafCreate = 0;
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("existing-only opened-inode authentication", () => {
  it("refuses a substitution swapped in before the database is retained", () => {
    const fixture = createSubstitutionFixture();
    fsState.actionsByLstat.set(1, fixture.swap);
    sqliteState.afterOpen = fixture.restore;

    expect(() => getExistingLcmConnection(fixture.dbPath)).toThrow(BINDING_ERROR);

    expect(isLcmConnectionOpen(fixture.dbPath)).toBe(false);
    fixture.settle();
    expectMarker(fixture.dbPath, "authentic");
  });

  it("refuses a substitution swapped in after the database is retained", () => {
    const fixture = createSubstitutionFixture();
    fsState.beforeLeafResolve = fixture.swap;
    sqliteState.afterOpen = fixture.restore;

    expect(() => getExistingLcmConnection(fixture.dbPath)).toThrow(BINDING_ERROR);

    expect(isLcmConnectionOpen(fixture.dbPath)).toBe(false);
    fixture.settle();
    expectMarker(fixture.dbPath, "authentic");
  });

  it("refuses a substitution parked under the rollback journal name", () => {
    const fixture = createSubstitutionFixture();
    const journalPath = `${fixture.dbPath}-journal`;
    tempDescriptors.push(openSync(fixture.dbPath, "r+"));
    // Staged after the leaf is retained so the parking action runs after the
    // constructor, which is the shape this pins.
    sqliteState.beforeOpen = fixture.swap;
    sqliteState.afterOpen = () => {
      renameSync(fixture.dbPath, journalPath);
      renameSync(fixture.stashPath, fixture.dbPath);
    };

    expect(() => getExistingLcmConnection(fixture.dbPath)).toThrow(BINDING_ERROR);

    expect(isLcmConnectionOpen(fixture.dbPath)).toBe(false);
    fixture.settle();
    expectMarker(fixture.dbPath, "authentic");
  });

  it("refuses a substitution laundered by reopening the database in the window", () => {
    const fixture = createSubstitutionFixture();
    tempDescriptors.push(openSync(fixture.dbPath, "r+"));
    sqliteState.beforeOpen = fixture.swap;
    sqliteState.afterOpen = () => {
      fixture.restore();
      tempDescriptors.push(openSync(fixture.dbPath, "r+"));
    };

    expect(() => getExistingLcmConnection(fixture.dbPath)).toThrow(BINDING_ERROR);

    expect(isLcmConnectionOpen(fixture.dbPath)).toBe(false);
    fixture.settle();
    expectMarker(fixture.dbPath, "authentic");
  });

  it("refuses a substitution that reuses a descriptor number freed in the window", () => {
    const fixture = createSubstitutionFixture();
    tempDescriptors.push(openSync(fixture.dbPath, "r+"));
    const padPath = join(dirname(fixture.dbPath), "pad.bin");
    writeFileSync(padPath, "pad");
    const padFd = openSync(padPath, "r+");
    sqliteState.beforeOpen = () => {
      closeSync(padFd);
      fixture.swap();
    };
    sqliteState.afterOpen = fixture.restore;

    expect(() => getExistingLcmConnection(fixture.dbPath)).toThrow(BINDING_ERROR);

    expect(isLcmConnectionOpen(fixture.dbPath)).toBe(false);
    fixture.settle();
    expectMarker(fixture.dbPath, "authentic");
  });

  it("refuses a substitution whose retained descriptor is unchanged across the open", () => {
    const fixture = createSubstitutionFixture();
    tempDescriptors.push(openSync(fixture.dbPath, "r+"));
    const substituteFd = openSync(fixture.substitutePath, "r+");
    sqliteState.beforeOpen = () => {
      closeSync(substituteFd);
      fixture.swap();
    };
    sqliteState.afterOpen = fixture.restore;

    expect(() => getExistingLcmConnection(fixture.dbPath)).toThrow(BINDING_ERROR);

    expect(isLcmConnectionOpen(fixture.dbPath)).toBe(false);
    fixture.settle();
    expectMarker(fixture.dbPath, "authentic");
  });

  it("refuses a substitution before changing permissions or running pragmas", () => {
    const fixture = createSubstitutionFixture("DELETE");
    chmodSync(fixture.dbPath, 0o644);
    chmodSync(fixture.substitutePath, 0o644);
    sqliteState.beforeOpen = fixture.swap;
    sqliteState.afterOpen = fixture.restore;

    expect(() => getExistingLcmConnection(fixture.dbPath)).toThrow(BINDING_ERROR);

    fixture.settle();
    expect(statSync(fixture.dbPath).mode & 0o777).toBe(0o644);
    expect(statSync(fixture.substitutePath).mode & 0o777).toBe(0o644);
    const substitute = new DatabaseSync(fixture.substitutePath);
    try {
      // A leaked "PRAGMA journal_mode = WAL" would have persisted in this file.
      expect(substitute.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    } finally {
      substitute.close();
    }
  });

  it("opens an unsubstituted database and pools the authenticated handle", () => {
    const fixture = createSubstitutionFixture();

    const db = getExistingLcmConnection(fixture.dbPath);

    expect(db).not.toBeNull();
    expect(db!.prepare("SELECT value FROM marker").get()).toEqual({ value: "authentic" });
    expect(isLcmConnectionOpen(fixture.dbPath)).toBe(true);
  });

  it("admits an open while unrelated work opens another file in the same window", () => {
    const fixture = createSubstitutionFixture();
    const unrelatedPath = join(dirname(fixture.dbPath), "unrelated.bin");
    writeFileSync(unrelatedPath, "unrelated");
    sqliteState.afterOpen = () => {
      tempDescriptors.push(openSync(unrelatedPath, "r+"));
    };

    const db = getExistingLcmConnection(fixture.dbPath);

    expect(db!.prepare("SELECT value FROM marker").get()).toEqual({ value: "authentic" });
    expect(isLcmConnectionOpen(fixture.dbPath)).toBe(true);
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

  it("refuses a substitution of an existing database in create-capable mode", () => {
    const fixture = createSubstitutionFixture();
    // A create-capable open resolves no leaf pathname, so the substitution is
    // timed on the admission lstat instead.
    fsState.actionsByLstat.set(1, fixture.swap);
    sqliteState.afterOpen = fixture.restore;

    expect(() => getLcmConnection(fixture.dbPath)).toThrow(BINDING_ERROR);

    expect(isLcmConnectionOpen(fixture.dbPath)).toBe(false);
    fixture.settle();
    expectMarker(fixture.dbPath, "authentic");
  });
});

describe("opened-inode substitution inside the retained window", () => {
  it("refuses a substitution staged and restored while SQLite opens", () => {
    const fixture = createSubstitutionFixture();
    // The swap lands after the leaf is retained and the restore lands before
    // the post-open pathname check, so only the retained witnesses can refuse.
    sqliteState.beforeOpen = fixture.swap;
    sqliteState.afterOpen = fixture.restore;

    expect(() => getExistingLcmConnection(fixture.dbPath)).toThrow(BINDING_ERROR);

    expect(isLcmConnectionOpen(fixture.dbPath)).toBe(false);
    fixture.settle();
    expectMarker(fixture.dbPath, "authentic");
  });

  it("refuses a substitution left in place while SQLite opens", () => {
    const fixture = createSubstitutionFixture();
    sqliteState.beforeOpen = fixture.swap;

    expect(() => getExistingLcmConnection(fixture.dbPath))
      .toThrow("database path changed while opening");

    expect(isLcmConnectionOpen(fixture.dbPath)).toBe(false);
    fixture.settle();
    expectMarker(fixture.dbPath, "authentic");
  });

  it("propagates a retained leaf close failure from an otherwise successful open", () => {
    const fixture = createSubstitutionFixture();
    fdState.failLeafClose = true;

    expect(() => getExistingLcmConnection(fixture.dbPath))
      .toThrow("injected retained leaf close failure");

    // The caller never receives the handle, so nothing may stay pooled for a
    // later caller to reuse with a reference no one can balance.
    expect(isLcmConnectionOpen(fixture.dbPath)).toBe(false);
  });

  it("keeps the substitution refusal when the retained leaf also fails to close", () => {
    const fixture = createSubstitutionFixture();
    sqliteState.beforeOpen = () => {
      fixture.swap();
      fdState.failLeafClose = true;
    };
    sqliteState.afterOpen = fixture.restore;

    expect(() => getExistingLcmConnection(fixture.dbPath)).toThrow(BINDING_ERROR);

    expect(isLcmConnectionOpen(fixture.dbPath)).toBe(false);
    fixture.settle();
    expectMarker(fixture.dbPath, "authentic");
  });
});


describe("create-capable opens of a missing database", () => {
  it("refuses a substitute planted at the pathname while SQLite opens", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-opened-inode-plant-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "created.sqlite");
    const plantPath = join(tempDir, "plant.sqlite");
    createMarkedDatabase(plantPath, "substitute", "DELETE");
    fsState.targetPath = dbPath;
    sqliteState.beforeOpen = () => renameSync(plantPath, dbPath);

    // The planted file replaces the leaf LCM created and retained, so the
    // pathname recheck names it before the witnesses are compared.
    expect(() => getLcmConnection(dbPath)).toThrow("database path changed while opening");

    expect(isLcmConnectionOpen(dbPath)).toBe(false);
    sqliteState.beforeOpen = undefined;
    // The planted database is never adopted, initialized, or pooled.
    expectMarker(dbPath, "substitute");
    const planted = new DatabaseSync(dbPath);
    try {
      expect(planted.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    } finally {
      planted.close();
    }
  });

  it("adopts the database another writer created first", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-opened-inode-race-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "created.sqlite");
    fsState.targetPath = dbPath;
    // The exclusive create loses the race, so LCM authenticates and retains the
    // database the winner created rather than creating its own.
    fdState.loseLeafCreateRace = true;

    const db = getLcmConnection(dbPath);

    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(isLcmConnectionOpen(dbPath)).toBe(true);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
  });
});


describe("create-capable reopen of an existing database", () => {
  it("admits a reopen that nothing else touches", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-opened-inode-reopen-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "existing.sqlite");
    createMarkedDatabase(dbPath, "existing");
    fsState.targetPath = dbPath;

    const db = getLcmConnection(dbPath);

    expect(db.prepare("SELECT value FROM marker").get()).toEqual({ value: "existing" });
  });
});

describe("create-capable leaf creation failures", () => {
  it("propagates a creation failure that is not a lost race", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-opened-inode-create-fail-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "created.sqlite");
    fsState.targetPath = dbPath;
    fdState.failLeafCreate = true;

    expect(() => getLcmConnection(dbPath)).toThrow("injected leaf creation failure");

    expect(isLcmConnectionOpen(dbPath)).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
  });
});

describe("create-capable leaf admission exhaustion", () => {
  it("refuses when the leaf can be neither created nor inspected", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-opened-inode-starve-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "created.sqlite");
    fsState.targetPath = dbPath;
    fdState.starveLeafCreate = 3;

    expect(() => getLcmConnection(dbPath)).toThrow(BINDING_ERROR);

    expect(isLcmConnectionOpen(dbPath)).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("creates the leaf on a later attempt when an earlier race is lost", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-opened-inode-retry-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "created.sqlite");
    fsState.targetPath = dbPath;
    fdState.starveLeafCreate = 1;

    const db = getLcmConnection(dbPath);

    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(isLcmConnectionOpen(dbPath)).toBe(true);
  });
});

describe("opened-inode substitution through the parent directory", () => {
  it("refuses a parent directory replaced and restored while SQLite opens", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-opened-inode-parent-"));
    tempDirs.push(root);
    const parentPath = join(root, "project");
    const substituteParentPath = join(root, "substitute");
    const stashParentPath = join(root, "stash");
    mkdirSync(parentPath, { mode: 0o700 });
    mkdirSync(substituteParentPath, { mode: 0o700 });
    const dbPath = join(parentPath, "db.sqlite");
    createMarkedDatabase(dbPath, "authentic");
    createMarkedDatabase(join(substituteParentPath, "db.sqlite"), "substitute");
    for (const directory of [parentPath, substituteParentPath]) {
      for (const leaf of readdirSync(directory)) {
        if (leaf.endsWith("-wal") || leaf.endsWith("-shm")) unlinkSync(join(directory, leaf));
      }
    }
    fsState.targetPath = dbPath;
    sqliteState.beforeOpen = () => {
      renameSync(parentPath, stashParentPath);
      renameSync(substituteParentPath, parentPath);
    };
    sqliteState.afterOpen = () => {
      renameSync(parentPath, substituteParentPath);
      renameSync(stashParentPath, parentPath);
    };

    expect(() => getExistingLcmConnection(dbPath)).toThrow(BINDING_ERROR);

    expect(isLcmConnectionOpen(dbPath)).toBe(false);
    sqliteState.beforeOpen = undefined;
    sqliteState.afterOpen = undefined;
    expectMarker(dbPath, "authentic");
  });
});
