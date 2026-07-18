import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ mode: "constructor" as "constructor" | "migration", execCalls: 0 }));
const closeLcmConnection = vi.hoisted(() => vi.fn());

vi.mock("../../src/db/connection.js", () => ({
  getLcmConnection: vi.fn(() => ({
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() => {
        if (state.mode === "constructor") throw "plain constructor failure";
        if (sql.includes("sqlite_master")) return { name: "schema_version" };
        if (sql.includes("SELECT version")) return { version: 1 };
        return undefined;
      }),
      run: vi.fn(),
    })),
    exec: vi.fn((sql: string) => {
      state.execCalls += 1;
      if (state.mode === "migration" && sql.includes("CREATE TABLE")) throw "plain migration failure";
    }),
  })),
  closeLcmConnection,
  isLcmConnectionOpen: vi.fn().mockReturnValue(false),
}));

import { EventsDb, _resetMigratedPathsForTesting } from "../../src/hooks/events-db.js";

describe("EventsDb non-Error migration failures", () => {
  beforeEach(() => {
    state.execCalls = 0;
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
    expect(state.execCalls).toBeGreaterThan(1);
  });
});
