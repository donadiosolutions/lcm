import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventRow, PatternReinforcementStats } from "../../../src/hooks/events-db.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";

const mocks = vi.hoisted(() => ({
  events: vi.fn(() => [] as EventRow[]),
  reinforcement: vi.fn((): PatternReinforcementStats => ({ totalCount: 0, distinctSessions: 0 })),
  mark: vi.fn(),
  setPrev: vi.fn(),
  closeEvents: vi.fn(),
  getConnection: vi.fn(() => ({})),
  collect: vi.fn(() => [] as unknown[]),
  storeSearch: vi.fn(() => [] as unknown[]),
  dedup: vi.fn(async () => "id"),
  closeConnection: vi.fn(),
  migrate: vi.fn(),
  validate: vi.fn((cwd: string) => cwd),
  log: vi.fn(),
  send: vi.fn(),
}));

vi.mock("../../../src/hooks/events-db.js", () => ({
  EventsDb: class {
    getUnprocessed = mocks.events;
    getPatternReinforcement = mocks.reinforcement;
    markProcessed = mocks.mark;
    setPrevEventId = mocks.setPrev;
    close = mocks.closeEvents;
  },
}));
vi.mock("../../../src/db/events-path.js", () => ({ eventsDbPath: () => "/events.db" }));
vi.mock("../../../src/db/promoted.js", () => ({ PromotedStore: class { search = mocks.storeSearch; } }));
vi.mock("../../../src/promotion/dedup.js", () => ({ deduplicateAndInsert: mocks.dedup }));
vi.mock("../../../src/daemon/server.js", () => ({ sendJson: mocks.send }));
vi.mock("../../../src/daemon/validate-cwd.js", () => ({ validateCwd: mocks.validate }));
vi.mock("../../../src/daemon/project.js", () => ({ projectId: () => "pid", projectDbPath: () => "/project.db" }));
vi.mock("../../../src/db/connection.js", () => ({ getLcmConnection: mocks.getConnection, closeLcmConnection: mocks.closeConnection }));
vi.mock("../../../src/db/migration.js", () => ({ runLcmMigrations: mocks.migrate }));
vi.mock("../../../src/hooks/hook-errors.js", () => ({ safeLogError: mocks.log }));
vi.mock("../../../src/db/event-sidecars.js", () => ({ collectEventSidecars: mocks.collect }));

import {
  createPromoteAllEventsHandler,
  drainEventsForCwd,
  promoteEventsForCwd,
} from "../../../src/daemon/routes/promote-events.js";

function event(overrides: Partial<EventRow>): EventRow {
  return {
    event_id: 1,
    session_id: "session",
    seq: 1,
    type: "decision",
    category: "decision",
    data: "decision",
    priority: 1,
    source_hook: "PostToolUse",
    processed: 0,
    created_at: "2026-01-01",
    ...overrides,
  } as EventRow;
}

const config = loadDaemonConfig("/tmp/promote-events-unit");

describe("promote-events unit boundaries", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.events.mockReturnValue([]);
    mocks.reinforcement.mockReturnValue({ totalCount: 0, distinctSessions: 0 });
    mocks.collect.mockReturnValue([]);
    mocks.getConnection.mockReturnValue({});
    mocks.storeSearch.mockReturnValue([]);
    mocks.dedup.mockResolvedValue("id");
    mocks.validate.mockImplementation((cwd: string) => cwd);
  });

  it("returns a generic global error when sidecar collection throws", async () => {
    mocks.collect.mockImplementationOnce(() => { throw new Error("scan failed"); });
    const response = {} as never;
    await createPromoteAllEventsHandler(config)({} as never, response, "");
    expect(mocks.log).toHaveBeenCalledWith("promote-events", expect.any(Error), {});
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "failed to promote events" });
  });

  it("reports incomplete global drains and skips closing connections that never opened", async () => {
    mocks.collect.mockReturnValueOnce([{
      projectId: "p", cwd: "/cwd", path: "/events.db", metadataMissing: false,
      captured: 1, unprocessed: 1, errors: 0, lastCapture: "2026", file: "p.db",
    }]);
    mocks.events.mockReturnValueOnce([event({ data: "fails" })]);
    mocks.dedup.mockRejectedValueOnce(new Error("dedup failed"));
    const response = {} as never;
    await createPromoteAllEventsHandler(config)({} as never, response, "");
    expect(mocks.send.mock.calls.at(-1)?.[2]).toMatchObject({ failedProjects: 1, processedProjects: 1 });

    mocks.getConnection.mockImplementationOnce(() => { throw new Error("open failed"); });
    await expect(drainEventsForCwd(config, "/cwd", "/events.db")).rejects.toThrow("open failed");
    mocks.getConnection.mockImplementationOnce(() => { throw new Error("open failed"); });
    await expect(promoteEventsForCwd(config, "/cwd", "/events.db")).rejects.toThrow("open failed");
  });

  it("distinguishes an initially empty drain", async () => {
    mocks.events.mockReturnValueOnce([]);
    await expect(drainEventsForCwd(config, "/cwd", "/events.db"))
      .resolves.toMatchObject({ batches: 0, message: "no unprocessed events" });
  });

  it("stops after the hard maximum when a sidecar never drains", async () => {
    mocks.events.mockImplementation(() => [event({ data: "repeating" })]);
    const result = await drainEventsForCwd(config, "/cwd", "/events.db");
    expect(result).toMatchObject({
      batches: 10_000,
      promoted: 10_000,
      incomplete: true,
      message: "stopped after maximum promotion batches",
    });
  });

  it("covers correlation tiers, reinforcement, existing matches, defaults, and event errors", async () => {
    const events = [
      event({ event_id: 1, session_id: "a", seq: 1, category: "error", type: "error", data: "cmd: fix broken" }),
      Object.assign(
        event({ event_id: 2, session_id: "a", seq: 2, category: "decision", type: "decision", data: "fix broken now" }),
        { _correlatedErrorId: 1, auto_tag: "type:solution" },
      ),
      Object.assign(
        event({ event_id: 9, session_id: "z", seq: 2, category: "git", type: "git", data: "fixed batch", priority: 2 }),
        { _correlatedErrorId: 1 },
      ),
      event({ event_id: 8, session_id: "plan", seq: 1, category: "plan", type: "plan", data: "planned", priority: 1 }),
      event({ event_id: 3, session_id: "b", seq: 1, category: "git", type: "git", data: "batch", priority: 2 }),
      event({ event_id: 4, session_id: "c", seq: 1, category: "custom", type: "custom", data: "unsupported", priority: 3 }),
      event({ event_id: 5, session_id: "d", seq: 1, category: "file", type: "file", data: "existing", priority: 3 }),
      event({ event_id: 6, session_id: "e", seq: 1, category: "file", type: "file", data: "reinforced", priority: 3 }),
      event({ event_id: 7, session_id: "f", seq: 1, category: "decision", type: "decision", data: "dedup-error", priority: 1 }),
    ];
    mocks.events.mockReturnValueOnce(events);
    mocks.storeSearch.mockImplementation((query: string) => query === "existing" ? [{ id: "match" }] : []);
    mocks.reinforcement.mockImplementation((_type: string, _category: string, data: string) =>
      data === "reinforced" ? { totalCount: 3, distinctSessions: 2 } : { totalCount: 0, distinctSessions: 0 });
    mocks.dedup.mockImplementation(async (input: { content: string }) => {
      if (input.content === "dedup-error") throw new Error("dedup failed");
      return "id";
    });
    const defaults = structuredClone(config);
    defaults.compaction.promotionThresholds.eventConfidence = {
      decision: undefined,
      plan: undefined,
      errorFix: undefined,
      batch: undefined,
      pattern: undefined,
    };
    defaults.compaction.promotionThresholds.dedupBm25Threshold = undefined;
    defaults.compaction.promotionThresholds.dedupCandidateLimit = undefined;
    defaults.compaction.promotionThresholds.insightsMaxAgeDays = undefined;
    defaults.compaction.promotionThresholds.maxConfidence = undefined;
    defaults.compaction.promotionThresholds.reinforcementBoost = undefined;

    const result = await promoteEventsForCwd(defaults, "/cwd", "/events.db");
    expect(result).toMatchObject({ promoted: 7, skipped: 1, correlated: 2, errors: 1 });
    expect(mocks.setPrev).toHaveBeenCalledWith(2, 1);
    expect(mocks.mark).toHaveBeenCalledWith(expect.arrayContaining([1, 2, 3, 4, 5, 6, 8, 9]));
  });
});
