import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

const sqliteState = vi.hoisted(() => ({
  failConstructor: false,
}));

vi.mock("node:sqlite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:sqlite")>();

  class ThrowingDatabaseSync extends actual.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
      if (sqliteState.failConstructor) {
        throw new Error("injected existing-only open failure");
      }
      super(...args);
    }
  }

  return { ...actual, DatabaseSync: ThrowingDatabaseSync };
});

import {
  closeLcmConnection,
  getExistingLcmConnection,
  isLcmConnectionOpen,
} from "../../src/db/connection.js";

const tempDirs: string[] = [];

afterEach(() => {
  sqliteState.failConstructor = false;
  closeLcmConnection();
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("existing-only connection constructor failures", () => {
  it("propagates a pre-assignment open failure without closing an undefined handle", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-conn-constructor-failure-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "existing.sqlite");
    writeFileSync(dbPath, "");
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    sqliteState.failConstructor = true;

    try {
      expect(() => getExistingLcmConnection(dbPath)).toThrow("injected existing-only open failure");
      expect(close).not.toHaveBeenCalled();
      expect(isLcmConnectionOpen(dbPath)).toBe(false);
    } finally {
      close.mockRestore();
    }
  });
});
