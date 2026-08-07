import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventRow, PatternReinforcementStats } from "../../../src/hooks/events-db.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { MachineIdentityFileError } from "../../../src/machine-identity.js";
import { UnavailablePostgreSqlStorageBackendFactory } from "../../../src/storage/factory.js";

const mocks = vi.hoisted(() => ({
  events: vi.fn(() => [] as EventRow[]),
  reinforcement: vi.fn((): PatternReinforcementStats => ({ totalCount: 0, distinctSessions: 0 })),
  mark: vi.fn(),
  observeMissingCwd: vi.fn(() => ({ parked: false, observations: 1, retryAfterMs: 5 * 60 * 1000 })),
  clearMissingCwd: vi.fn(),
  setPrev: vi.fn(),
  closeEvents: vi.fn(),
  collect: vi.fn(() => [] as unknown[]),
  storeSearch: vi.fn(() => [] as unknown[]),
  dedup: vi.fn(async () => "id"),
  openProject: vi.fn(),
  closeProject: vi.fn(),
  closeFactory: vi.fn(),
  transaction: vi.fn(async (callback: (repositories: unknown) => Promise<unknown>) => callback({})),
  validate: vi.fn((cwd: string) => cwd),
  log: vi.fn(),
  send: vi.fn(),
  scrub: vi.fn((text: string) => text),
  identity: vi.fn(() => ({ id: "pid", canonical: "/cwd" })),
  openOutbox: vi.fn(),
  eventsPath: vi.fn(() => "/events.db"),
}));
const missingCwdError = vi.hoisted(() => new Error("missing cwd"));

vi.mock("../../../src/hooks/events-db.js", () => ({
  EventsDb: class EventsDb {
    static openExisting() {
      return new EventsDb();
    }

    constructor() { mocks.openOutbox(); }
    getUnprocessed = mocks.events;
    getPatternReinforcement = mocks.reinforcement;
    markProcessed = mocks.mark;
    observeMissingCwd = mocks.observeMissingCwd;
    clearMissingCwd = mocks.clearMissingCwd;
    setPrevEventId = mocks.setPrev;
    close = mocks.closeEvents;
  },
}));
vi.mock("../../../src/db/events-path.js", () => ({ eventsDbPath: mocks.eventsPath }));
vi.mock("../../../src/promotion/dedup.js", () => ({ deduplicateAndInsert: mocks.dedup }));
vi.mock("../../../src/daemon/server.js", () => ({ sendJson: mocks.send }));
vi.mock("../../../src/daemon/validate-cwd.js", () => ({
  validateCwd: mocks.validate,
  isMissingCwdError: (error: unknown) => error === missingCwdError,
}));
vi.mock("../../../src/daemon/project.js", () => ({
  projectDir: () => "/project",
  projectIdentity: mocks.identity,
}));
vi.mock("../../../src/storage/index.js", () => ({
  createStorageBackendFactory: () => ({ openProject: mocks.openProject, close: mocks.closeFactory }),
}));
vi.mock("../../../src/hooks/hook-errors.js", () => ({ safeLogError: mocks.log }));
vi.mock("../../../src/db/event-sidecars.js", () => ({ collectEventSidecars: mocks.collect }));
vi.mock("../../../src/scrub.js", () => ({
  ScrubEngine: { forProject: async () => ({ scrub: mocks.scrub }) },
}));

import {
  createPromoteAllEventsHandler,
  createPromoteEventsHandler,
  drainEventsForCwd,
  parkUnavailableCwdEvents,
  promoteEventsForCwd,
} from "../../../src/daemon/routes/promote-events.js";
import {
  createPromoteEventsNotifyHandler,
  PassiveEventProcessor,
  PASSIVE_EVENT_PROCESSOR_DEFAULTS,
} from "../../../src/daemon/passive-event-processor.js";

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
const postgresqlConfig = {
  ...config,
  storage: {
    backend: "postgresql",
    postgresql: {
      url: "postgresql://user:secret@db.example/lcm",
      poolMax: 5,
      connectionTimeoutMs: 10_000,
      idleTimeoutMs: 30_000,
      statementTimeoutMs: 60_000,
    },
  },
} as const;

function projectStorage() {
  return {
    projectId: "pid",
    promotedMemory: {},
    lexicalSearch: { searchPromoted: mocks.storeSearch },
    transaction: mocks.transaction,
    close: mocks.closeProject,
  };
}

describe("promote-events unit boundaries", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.events.mockReturnValue([]);
    mocks.reinforcement.mockReturnValue({ totalCount: 0, distinctSessions: 0 });
    mocks.observeMissingCwd.mockReturnValue({
      parked: false,
      observations: 1,
      retryAfterMs: 5 * 60 * 1000,
    });
    mocks.collect.mockReturnValue([]);
    mocks.openProject.mockResolvedValue(projectStorage());
    mocks.storeSearch.mockReturnValue([]);
    mocks.dedup.mockResolvedValue("id");
    mocks.validate.mockImplementation((cwd: string) => cwd);
    mocks.scrub.mockImplementation((text: string) => text);
    mocks.identity.mockReturnValue({ id: "pid", canonical: "/cwd" });
    mocks.eventsPath.mockReturnValue("/events.db");
    mocks.closeProject.mockResolvedValue(undefined);
    mocks.closeFactory.mockResolvedValue(undefined);
    mocks.closeEvents.mockImplementation(() => undefined);
  });

  it("returns a generic global error when sidecar collection throws", async () => {
    mocks.collect.mockImplementationOnce(() => { throw new Error("scan failed"); });
    const response = {} as never;
    await createPromoteAllEventsHandler(config)({} as never, response, "");
    expect(mocks.log).toHaveBeenCalledWith("promote-events", expect.any(Error), {});
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "failed to promote events" });
  });

  it("fails identity before opening the local outbox for direct, drain, all, and notify paths", async () => {
    const identityFailure = new Error("PostgreSQL project binding is required");
    mocks.identity.mockImplementation(() => { throw identityFailure; });

    await expect(promoteEventsForCwd(config, "/cwd", "/events.db"))
      .rejects.toBe(identityFailure);
    await expect(drainEventsForCwd(config, "/cwd", "/events.db"))
      .rejects.toBe(identityFailure);

    const directResponse = {} as never;
    await createPromoteEventsHandler(config)(
      {} as never,
      directResponse,
      JSON.stringify({ cwd: "/cwd" }),
    );
    expect(mocks.send).toHaveBeenLastCalledWith(directResponse, 500, {
      error: "failed to promote events",
    });

    mocks.collect.mockReturnValueOnce([{
      projectId: "pid",
      cwd: "/cwd",
      path: "/events.db",
      metadataMissing: false,
      captured: 1,
      unprocessed: 1,
      errors: 0,
      lastCapture: "2026",
      file: "pid.db",
    }]);
    const allResponse = {} as never;
    await createPromoteAllEventsHandler(config)({} as never, allResponse, "");
    expect(mocks.send.mock.calls.at(-1)?.[2]).toMatchObject({
      failedProjects: 1,
      processedProjects: 0,
    });

    const processor = new PassiveEventProcessor(
      config,
      PASSIVE_EVENT_PROCESSOR_DEFAULTS,
      {
        promoteEventsForCwd,
        setTimeout: vi.fn(() => ({ unref: vi.fn() })) as never,
        clearTimeout: vi.fn() as never,
        setInterval: vi.fn() as never,
        clearInterval: vi.fn() as never,
        safeLogError: mocks.log,
      },
    );
    const notifyResponse = {} as never;
    await createPromoteEventsNotifyHandler(processor)(
      {} as never,
      notifyResponse,
      JSON.stringify({ cwd: "/cwd", priority: 1 }),
    );
    await processor.flushOnce();
    expect(mocks.send).toHaveBeenCalledWith(notifyResponse, 200, { queued: true });
    expect(mocks.log).toHaveBeenCalledWith(
      "passive-event-processor",
      identityFailure,
      { cwd: "/cwd" },
    );
    expect(mocks.openOutbox).not.toHaveBeenCalled();
    expect(mocks.openProject).not.toHaveBeenCalled();
  });

  it("returns the typed identity response when a global sidecar drain fails admission", async () => {
    const identityFailure = new MachineIdentityFileError(
      "machine identity is not registered",
      "Run `lcm machine register`.",
    );
    mocks.identity.mockImplementation(() => { throw identityFailure; });
    mocks.collect.mockReturnValueOnce([{
      projectId: "pid",
      cwd: "/cwd",
      path: "/events.db",
      metadataMissing: false,
      captured: 1,
      unprocessed: 1,
      errors: 0,
      lastCapture: "2026",
      file: "pid.db",
    }]);

    const response = {} as never;
    await createPromoteAllEventsHandler(postgresqlConfig)({} as never, response, "");

    expect(mocks.send).toHaveBeenLastCalledWith(response, 409, {
      code: "STORAGE_IDENTITY_REQUIRED",
      error: "Machine identity is unavailable. Run `lcm machine show` for recovery guidance.",
      storageBackend: "postgresql",
    });
    expect(mocks.openOutbox).not.toHaveBeenCalled();
  });

  it("admits PostgreSQL storage before opening either promotion outbox", async () => {
    const staged = new UnavailablePostgreSqlStorageBackendFactory();

    await expect(drainEventsForCwd(
      postgresqlConfig,
      "/cwd",
      "/events.db",
      staged,
    )).rejects.toThrow("postgresql storage initialization failed for project pid");
    expect(mocks.openOutbox).not.toHaveBeenCalled();

    const response = {} as never;
    await createPromoteEventsHandler(postgresqlConfig, staged)(
      {} as never,
      response,
      JSON.stringify({ cwd: "/cwd" }),
    );
    expect(mocks.send).toHaveBeenLastCalledWith(response, 503, {
      code: "STORAGE_BACKEND_STAGED",
      error: "promote-events is unavailable while PostgreSQL storage repositories are staged",
      storageBackend: "postgresql",
    });
    expect(mocks.openOutbox).not.toHaveBeenCalled();
  });

  it("reports incomplete global drains and closes owned factories when projects fail to open", async () => {
    mocks.collect.mockReturnValueOnce([{
      projectId: "p", cwd: "/cwd", path: "/events.db", metadataMissing: false,
      captured: 1, unprocessed: 1, errors: 0, lastCapture: "2026", file: "p.db",
    }]);
    mocks.events.mockReturnValueOnce([event({ data: "fails" })]);
    mocks.dedup.mockRejectedValueOnce(new Error("dedup failed"));
    const response = {} as never;
    await createPromoteAllEventsHandler(config)({} as never, response, "");
    expect(mocks.send.mock.calls.at(-1)?.[2]).toMatchObject({ failedProjects: 1, processedProjects: 1 });

    mocks.openProject.mockRejectedValueOnce(new Error("open failed"));
    await expect(drainEventsForCwd(config, "/cwd", "/events.db")).rejects.toThrow("open failed");
    mocks.openProject.mockRejectedValueOnce(new Error("open failed"));
    await expect(promoteEventsForCwd(config, "/cwd", "/events.db")).rejects.toThrow("open failed");
    expect(mocks.closeFactory).toHaveBeenCalledTimes(3);
  });

  it("distinguishes an initially empty drain", async () => {
    mocks.events.mockReturnValueOnce([]);
    await expect(drainEventsForCwd(config, "/cwd", "/events.db"))
      .resolves.toMatchObject({ batches: 0, message: "no unprocessed events" });
    expect(mocks.identity.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.openOutbox.mock.invocationCallOrder[0]);
    expect(mocks.openOutbox.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.openProject.mock.invocationCallOrder[0]);
  });

  it("uses but does not close an injected process storage factory", async () => {
    const injectedFactory = { openProject: mocks.openProject, close: mocks.closeFactory } as never;
    const response = {} as never;

    await createPromoteEventsHandler(config, injectedFactory)(
      {} as never,
      response,
      JSON.stringify({ cwd: "/cwd" }),
    );

    expect(mocks.openProject).toHaveBeenCalledWith({ id: "pid", canonical: "/cwd" });
    expect(mocks.closeProject).toHaveBeenCalledOnce();
    expect(mocks.closeFactory).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, expect.objectContaining({
      message: "no unprocessed events",
    }));
  });

  it("settles every cleanup failure without replacing a successful result", async () => {
    mocks.closeProject.mockRejectedValueOnce(new Error("project close failed"));
    mocks.closeEvents.mockImplementationOnce(() => { throw new Error("outbox close failed"); });
    mocks.closeFactory.mockRejectedValueOnce(new Error("factory close failed"));

    await expect(promoteEventsForCwd(config, "/cwd", "/events.db"))
      .resolves.toMatchObject({ message: "no unprocessed events" });

    expect(mocks.closeProject).toHaveBeenCalledOnce();
    expect(mocks.closeEvents).toHaveBeenCalledOnce();
    expect(mocks.closeFactory).toHaveBeenCalledOnce();
  });

  it("preserves the primary failure while settling partially constructed resources", async () => {
    const primary = new Error("open failed");
    mocks.openProject.mockRejectedValueOnce(primary);
    mocks.closeEvents.mockImplementationOnce(() => { throw new Error("outbox close failed"); });
    mocks.closeFactory.mockRejectedValueOnce(new Error("factory close failed"));

    await expect(promoteEventsForCwd(config, "/cwd", "/events.db")).rejects.toBe(primary);
    expect(mocks.closeProject).not.toHaveBeenCalled();
    expect(mocks.closeEvents).toHaveBeenCalledOnce();
    expect(mocks.closeFactory).toHaveBeenCalledOnce();
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
    expect(mocks.scrub).toHaveBeenCalledTimes(10_000);
  });

  it("parks through durable sidecar state without consuming unprocessed rows", async () => {
    mocks.observeMissingCwd.mockReturnValue({ parked: true, observations: 3, retryAfterMs: 0 });
    mocks.validate.mockImplementation(() => { throw missingCwdError; });

    const result = await parkUnavailableCwdEvents("/missing", "/events.db");

    expect(result).toMatchObject({
      promoted: 0,
      skipped: 0,
      correlated: 0,
      errors: 0,
      terminal: { kind: "parked", reason: "unavailable-cwd" },
    });
    expect(mocks.events).not.toHaveBeenCalled();
    expect(mocks.mark).not.toHaveBeenCalled();
    expect(mocks.observeMissingCwd).toHaveBeenCalledOnce();
  });

  it.each(["EACCES", "EPERM"] as const)(
    "fails closed on initial cwd %s without opening or mutating the sidecar",
    async (code) => {
      const failure = Object.assign(new Error(`${code}: cwd denied`), { code });
      mocks.validate.mockImplementation(() => { throw failure; });

      await expect(promoteEventsForCwd(config, "/denied-cwd"))
        .rejects.toBe(failure);
      expect(mocks.openOutbox).not.toHaveBeenCalled();
      expect(mocks.observeMissingCwd).not.toHaveBeenCalled();
      expect(mocks.clearMissingCwd).not.toHaveBeenCalled();
      expect(mocks.events).not.toHaveBeenCalled();
      expect(mocks.mark).not.toHaveBeenCalled();
    },
  );

  it("normalizes an equivalent missing cwd before deriving its sidecar path", async () => {
    const lexical = "/workspace/child/../missing/";
    mocks.validate.mockImplementation((cwd: string, options?: { allowMissing?: boolean }) => {
      if (options?.allowMissing) return "/workspace/missing";
      if (cwd === lexical) throw missingCwdError;
      return cwd;
    });

    await expect(promoteEventsForCwd(config, lexical)).resolves.toMatchObject({
      deferred: { kind: "awaiting-confirmation", observations: 1 },
    });
    expect(mocks.eventsPath).toHaveBeenCalledOnce();
    expect(mocks.eventsPath).toHaveBeenCalledWith("/workspace/missing");
    expect(mocks.observeMissingCwd).toHaveBeenCalledOnce();
  });

  it.each(["EACCES", "EPERM"] as const)(
    "fails closed when cwd revalidation changes to %s after lock acquisition",
    async (code) => {
      const failure = Object.assign(new Error(`${code}: cwd denied under lock`), { code });
      mocks.validate
        .mockReturnValueOnce("/cwd")
        .mockImplementationOnce(() => { throw failure; });

      await expect(promoteEventsForCwd(config, "/cwd"))
        .rejects.toBe(failure);
      expect(mocks.openOutbox).not.toHaveBeenCalled();
      expect(mocks.observeMissingCwd).not.toHaveBeenCalled();
      expect(mocks.clearMissingCwd).not.toHaveBeenCalled();
      expect(mocks.mark).not.toHaveBeenCalled();
    },
  );

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
    mocks.dedup.mockImplementation(async (input: {
      content: string;
      transaction: (callback: () => Promise<void>) => Promise<void>;
    }) => {
      if (input.content === "dedup-error") throw new Error("dedup failed");
      await input.transaction(async () => undefined);
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

  it("scopes tier 3 eligibility to the current project attribution", async () => {
    mocks.events.mockReturnValueOnce([
      event({ event_id: 1, category: "file", type: "file", data: "foreign-only", priority: 3 }),
      event({ event_id: 2, category: "file", type: "file", data: "same-project", priority: 3 }),
    ]);
    mocks.storeSearch.mockImplementation(
      (query: string, _limit: number, _tags: string[] | undefined, sourceProjectId: string | undefined) => {
        if (query === "foreign-only") {
          return sourceProjectId === undefined ? [{ id: "foreign" }] : [];
        }
        return sourceProjectId === "pid" ? [{ id: "same-project" }] : [];
      },
    );

    await expect(promoteEventsForCwd(config, "/cwd", "/events.db")).resolves.toMatchObject({
      promoted: 1,
      skipped: 1,
      errors: 0,
    });
    expect(mocks.storeSearch).toHaveBeenNthCalledWith(1, "foreign-only", 1, undefined, "pid");
    expect(mocks.storeSearch).toHaveBeenNthCalledWith(2, "same-project", 1, undefined, "pid");
    expect(mocks.dedup).toHaveBeenCalledOnce();
    expect(mocks.dedup).toHaveBeenCalledWith(expect.objectContaining({
      content: "same-project",
      sourceProjectId: "pid",
    }));
    expect(mocks.mark).toHaveBeenCalledWith([1, 2]);
  });
});
