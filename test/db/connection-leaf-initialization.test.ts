import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsState = vi.hoisted(() => ({
  targetPath: "",
  targetLstats: 0,
  targetChmods: 0,
  afterFirstTargetLstat: undefined as (() => void) | undefined,
  cleanupDirectories: new Set<string>(),
}));

const sqliteState = vi.hoisted(() => ({
  nextOpenAction: undefined as (() => void) | undefined,
  trackedHandles: new Set<object>(),
  trackedCloses: 0,
  trackedExecs: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    chmodSync: (...args: Parameters<typeof actual.chmodSync>) => {
      if (String(args[0]) === fsState.targetPath) fsState.targetChmods += 1;
      return actual.chmodSync(...args);
    },
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      const stat = actual.lstatSync(...args);
      if (String(args[0]) === fsState.targetPath) {
        fsState.targetLstats += 1;
        if (fsState.targetLstats === 1) {
          const action = fsState.afterFirstTargetLstat;
          fsState.afterFirstTargetLstat = undefined;
          action?.();
        }
      }
      return stat;
    },
    realpathSync: actual.realpathSync,
  };
});

vi.mock("node:sqlite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:sqlite")>();

  class TrackedDatabaseSync extends actual.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
      super(...args);
      const action = sqliteState.nextOpenAction;
      if (action) {
        sqliteState.nextOpenAction = undefined;
        sqliteState.trackedHandles.add(this);
        action();
      }
    }

    exec(sql: string): void {
      if (sqliteState.trackedHandles.has(this)) sqliteState.trackedExecs += 1;
      super.exec(sql);
    }

    close(): void {
      if (sqliteState.trackedHandles.has(this)) sqliteState.trackedCloses += 1;
      super.close();
    }
  }

  return { ...actual, DatabaseSync: TrackedDatabaseSync };
});

import { DatabaseSync } from "node:sqlite";
import {
  closeLcmConnection,
  getExistingLcmConnection,
  getLcmConnection,
  isLcmConnectionOpen,
} from "../../src/db/connection.js";

const tempDirs: string[] = [];

function createMarkedDatabase(path: string, marker: string): void {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE marker (value TEXT NOT NULL)");
  db.prepare("INSERT INTO marker VALUES (?)").run(marker);
  db.close();
}

function expectDatabaseState(path: string, marker: string, journalMode: string): void {
  const db = new DatabaseSync(path);
  try {
    expect(db.prepare("SELECT value FROM marker").get()).toEqual({ value: marker });
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: journalMode });
  } finally {
    db.close();
  }
}

function armTrackedOpen(action: () => void = () => undefined): void {
  sqliteState.nextOpenAction = action;
}

afterEach(() => {
  closeLcmConnection();
  fsState.targetPath = "";
  fsState.targetLstats = 0;
  fsState.targetChmods = 0;
  fsState.afterFirstTargetLstat = undefined;
  sqliteState.nextOpenAction = undefined;
  sqliteState.trackedHandles.clear();
  sqliteState.trackedCloses = 0;
  sqliteState.trackedExecs = 0;
  for (const directory of fsState.cleanupDirectories) {
    try {
      chmodSync(directory, 0o700);
    } catch {
      // The topology fixture may already have been removed.
    }
  }
  fsState.cleanupDirectories.clear();
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("persistent SQLite leaf initialization admission", () => {
  it.each([
    ["create-capable", getLcmConnection],
    ["existing-only", getExistingLcmConnection],
  ])("rejects a pre-open leaf swap before mutating it in %s mode", (_label, open) => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-leaf-pre-open-swap-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "events.sqlite");
    const originalPath = join(tempDir, "events.original.sqlite");
    const replacementPath = join(tempDir, "events.replacement.sqlite");
    createMarkedDatabase(dbPath, "original");
    createMarkedDatabase(replacementPath, "replacement");
    chmodSync(dbPath, 0o644);
    chmodSync(replacementPath, 0o644);
    const originalIdentity = statSync(dbPath);

    fsState.targetPath = dbPath;
    fsState.targetChmods = 0;
    fsState.afterFirstTargetLstat = () => {
      renameSync(dbPath, originalPath);
      renameSync(replacementPath, dbPath);
    };
    armTrackedOpen();

    expect(() => open(dbPath)).toThrow("database path changed while opening");

    expect(fsState.targetChmods).toBe(0);
    expect(sqliteState.trackedExecs).toBe(0);
    expect(sqliteState.trackedCloses).toBe(1);
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
    expect(statSync(dbPath).mode & 0o777).toBe(0o644);
    expect(statSync(originalPath).ino).toBe(originalIdentity.ino);
    expectDatabaseState(dbPath, "replacement", "delete");
    expectDatabaseState(originalPath, "original", "delete");
  });

  it.each([
    ["create-capable", getLcmConnection, "throws"],
    ["existing-only", getExistingLcmConnection, "returns null"],
  ])("closes a post-open missing leaf before initialization in %s mode", (_label, open, result) => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-leaf-post-open-missing-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "events.sqlite");
    createMarkedDatabase(dbPath, "original");

    fsState.targetPath = dbPath;
    fsState.targetChmods = 0;
    armTrackedOpen(() => rmSync(dbPath));

    if (result === "throws") {
      expect(() => open(dbPath)).toThrow("database path disappeared while opening");
    } else {
      expect(open(dbPath)).toBeNull();
    }

    expect(fsState.targetChmods).toBe(0);
    expect(sqliteState.trackedExecs).toBe(0);
    expect(sqliteState.trackedCloses).toBe(1);
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
  });

  it.each([
    ["symlink", "create-capable", getLcmConnection],
    ["symlink", "existing-only", getExistingLcmConnection],
    ["directory", "create-capable", getLcmConnection],
    ["directory", "existing-only", getExistingLcmConnection],
  ])("rejects a post-open %s leaf before initialization in %s mode", (
    topology,
    _mode,
    open,
  ) => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-leaf-post-open-topology-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "events.sqlite");
    const originalPath = join(tempDir, "events.original.sqlite");
    const victimPath = join(tempDir, "victim.sqlite");
    createMarkedDatabase(dbPath, "original");
    createMarkedDatabase(victimPath, "victim");
    chmodSync(victimPath, 0o644);

    fsState.targetPath = dbPath;
    fsState.targetChmods = 0;
    armTrackedOpen(() => {
      renameSync(dbPath, originalPath);
      if (topology === "symlink") {
        symlinkSync(victimPath, dbPath);
      } else {
        mkdirSync(dbPath, { mode: 0o755 });
        fsState.cleanupDirectories.add(dbPath);
      }
    });

    expect(() => open(dbPath)).toThrow(
      topology === "symlink" ? "symlink database path" : "not a regular file",
    );

    expect(fsState.targetChmods).toBe(0);
    expect(sqliteState.trackedExecs).toBe(0);
    expect(sqliteState.trackedCloses).toBe(1);
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
    if (topology === "symlink") {
      expect(lstatSync(dbPath).isSymbolicLink()).toBe(true);
      expect(statSync(victimPath).mode & 0o777).toBe(0o644);
      expectDatabaseState(victimPath, "victim", "delete");
    } else {
      expect(statSync(dbPath).mode & 0o777).toBe(0o755);
    }
    expectDatabaseState(originalPath, "original", "delete");
  });
});
