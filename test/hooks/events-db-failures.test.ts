import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  mode: "constructor" as "constructor" | "migration" | "bootstrap" | "stale-migrator",
  execSql: [] as string[],
  selectedSql: [] as string[],
  versionReads: 0,
}));
const closeLcmConnection = vi.hoisted(() => vi.fn());

vi.mock("../../src/db/connection.js", () => ({
  getLcmConnection: vi.fn(() => ({
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() => {
        if (state.mode === "constructor") throw "plain constructor failure";
        if (sql.includes("sqlite_master")) {
          return state.mode === "bootstrap" ? undefined : { name: "schema_version" };
        }
        if (sql.includes("SELECT version")) {
          state.versionReads += 1;
          return {
            version: state.mode === "stale-migrator" && state.versionReads > 1 ? 4 : 1,
          };
        }
        return undefined;
      }),
      run: vi.fn(() => {
        if (state.mode === "bootstrap" && sql.includes("INSERT INTO schema_version")) {
          throw "plain schema-version failure";
        }
      }),
      all: vi.fn(() => {
        state.selectedSql.push(sql);
        return [];
      }),
    })),
    exec: vi.fn((sql: string) => {
      state.execSql.push(sql);
      if (state.mode === "bootstrap" && sql === "ROLLBACK") throw "plain rollback failure";
      if (state.mode === "migration" && sql.includes("CREATE TABLE")) throw "plain migration failure";
    }),
  })),
  closeLcmConnection,
  isLcmConnectionOpen: vi.fn().mockReturnValue(false),
}));

import { EventsDb, _resetMigratedPathsForTesting } from "../../src/hooks/events-db.js";

describe("EventsDb non-Error migration failures", () => {
  beforeEach(() => {
    state.execSql = [];
    state.selectedSql = [];
    state.versionReads = 0;
    closeLcmConnection.mockClear();
    _resetMigratedPathsForTesting();
  });

  it("sanitizes and releases a constructor-stage non-Error failure", () => {
    state.mode = "constructor";
    expect(() => new EventsDb("/tmp/lcm-events-constructor/test.db")).toThrow("plain constructor failure");
    expect(closeLcmConnection).toHaveBeenCalled();
  });

  it("sanitizes a migration-stage non-Error failure after rollback", () => {
    state.mode = "migration";
    expect(() => new EventsDb("/tmp/lcm-events-migration/test.db")).toThrow("plain migration failure");
    expect(state.execSql[0]).toBe("BEGIN EXCLUSIVE");
    expect(state.execSql.at(-1)).toBe("ROLLBACK");
    expect(state.execSql).not.toContain("COMMIT");
  });

  it("rolls back an initial bootstrap when schema-version insertion fails", () => {
    state.mode = "bootstrap";
    expect(() => new EventsDb("/tmp/lcm-events-bootstrap/test.db")).toThrow("plain schema-version failure");
    expect(state.execSql[0]).toBe("BEGIN EXCLUSIVE");
    expect(state.execSql[1]).toContain("CREATE TABLE IF NOT EXISTS schema_version");
    expect(state.execSql.at(-1)).toBe("ROLLBACK");
    expect(state.execSql).not.toContain("COMMIT");
    expect(closeLcmConnection).toHaveBeenCalledOnce();
  });

  it("rechecks a stale migration under the lock and preserves the current schema", () => {
    state.mode = "stale-migrator";
    const db = new EventsDb("/tmp/lcm-events-stale-migrator/test.db");

    expect(state.versionReads).toBe(2);
    expect(state.execSql[0]).toBe("BEGIN EXCLUSIVE");
    expect(state.selectedSql).toEqual([]);
    expect(state.execSql).not.toContain("DROP TABLE IF EXISTS events_v4");
    expect(state.execSql.at(-1)).toBe("COMMIT");

    db.close();
  });
});
