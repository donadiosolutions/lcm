import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { loadDaemonConfig, type DaemonConfig } from "../../../src/daemon/config.js";
import type { ProjectStorage, StorageBackendFactory } from "../../../src/storage/index.js";
import { StorageOperationError } from "../../../src/storage/errors.js";
import type { RouteExecutionContext } from "../../../src/daemon/server.js";
import {
  makeMockStorageFactory,
} from "./mock-storage-factory.js";

const mocks = vi.hoisted(() => ({
  exists: vi.fn(() => true),
  getConnection: vi.fn(),
  dbClose: vi.fn(),
  dbAll: vi.fn(() => [] as unknown[]),
  migrate: vi.fn(),
  validate: vi.fn((cwd: string) => cwd),
  describe: vi.fn(async () => ({ id: "node" })),
  expand: vi.fn(async () => ({ expanded: ["node"] })),
  grep: vi.fn(async () => ({ messages: [], summaries: [], matches: [] })),
  poolStats: vi.fn(() => ({ totalConnections: 0 })),
  stats: vi.fn(() => ({ projects: 0 })),
  promotedSearch: vi.fn(() => [] as unknown[]),
  recentSummaries: vi.fn(async () => [] as unknown[]),
  projectClose: vi.fn(async () => undefined),
  factoryClose: vi.fn(async () => undefined),
  openProject: vi.fn(),
  createFactory: vi.fn(),
  projectExists: vi.fn(async () => true),
  projectIdentity: vi.fn((cwd: string) => ({ id: cwd, canonical: cwd })),
  send: vi.fn(),
  writeHead: vi.fn(),
  end: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  existsSync: mocks.exists,
}));
vi.mock("../../../src/daemon/project.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/daemon/project.js")>(),
  projectDbPath: (cwd: string) => `${cwd}/lcm.db`,
  projectIdentity: mocks.projectIdentity,
}));
vi.mock("../../../src/daemon/server.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/daemon/server.js")>(),
  sendJson: mocks.send,
}));
vi.mock("../../../src/db/migration.js", () => ({ runLcmMigrations: mocks.migrate }));
vi.mock("../../../src/daemon/validate-cwd.js", () => ({ validateCwd: mocks.validate }));
vi.mock("../../../src/retrieval.js", () => ({
  createRetrievalEngine: () => ({
    describe: mocks.describe,
    grep: mocks.grep,
  }),
}));
vi.mock("../../../src/expansion.js", () => ({
  ExpansionOrchestrator: class { expand = mocks.expand; },
}));
vi.mock("../../../src/store/conversation-store.js", () => ({ ConversationStore: class {} }));
vi.mock("../../../src/store/summary-store.js", () => ({ SummaryStore: class {} }));
vi.mock("../../../src/db/connection.js", () => ({
  getLcmConnection: mocks.getConnection,
  closeLcmConnection: mocks.dbClose,
  getPoolStats: mocks.poolStats,
}));
vi.mock("../../../src/db/promoted.js", () => ({
  PromotedStore: class { search = mocks.promotedSearch; },
}));
vi.mock("../../../src/storage/index.js", () => ({
  createStorageBackendFactory: mocks.createFactory,
}));
vi.mock("../../../src/stats.js", () => ({ collectStats: mocks.stats }));

import { createDescribeHandler } from "../../../src/daemon/routes/describe.js";
import { createExpandHandler } from "../../../src/daemon/routes/expand.js";
import { createGrepHandler } from "../../../src/daemon/routes/grep.js";
import { createRecentHandler } from "../../../src/daemon/routes/recent.js";
import { createPoolStatsHandler } from "../../../src/daemon/routes/pool-stats.js";
import { createStatsHandler } from "../../../src/daemon/routes/stats.js";
import { createSearchHandler } from "../../../src/daemon/routes/search.js";
import { MachineIdentityFileError } from "../../../src/machine-identity.js";
import { StorageIdentityConfigurationError } from "../../../src/storage/identity-context.js";

const config = loadDaemonConfig("/tmp/lcm-persistence-routes");
const response = {
  writeHead: mocks.writeHead,
  end: mocks.end,
} as unknown as ServerResponse;

function injectedFactory(): StorageBackendFactory {
  return makeMockStorageFactory({
    projectExists: mocks.projectExists,
    openProject: mocks.openProject,
    close: mocks.factoryClose,
  });
}

function postgresqlConfig(): DaemonConfig {
  const value = loadDaemonConfig("/tmp/lcm-persistence-routes-postgresql");
  value.storage = {
    backend: "postgresql",
    postgresql: {
      url: "postgresql://user:secret@db.example/lcm",
      poolMax: 5,
      connectionTimeoutMs: 10_000,
      idleTimeoutMs: 30_000,
      statementTimeoutMs: 60_000,
    },
  };
  return value;
}

function postgresqlFactory(factory: StorageBackendFactory): StorageBackendFactory {
  return {
    ...factory,
    backend: "postgresql",
    capabilities: {
      ...factory.capabilities,
      coordination: "distributed",
    },
  };
}

function storageFailure(domain: "factory" | "lexical-search" | "summaries", operation: string): StorageOperationError {
  return new StorageOperationError(
    "STORAGE_OPERATION_FAILED",
    "postgresql",
    "/ok",
    domain,
    operation,
  );
}

async function invoke(
  handler: ReturnType<typeof createDescribeHandler>,
  body: Record<string, unknown> | string,
  context?: RouteExecutionContext,
): Promise<void> {
  await handler({} as never, response, typeof body === "string" ? body : JSON.stringify(body), context);
}

function expectLast(status: number, payload: unknown): void {
  if (mocks.send.mock.calls.length > 0) {
    expect(mocks.send).toHaveBeenLastCalledWith(response, status, payload);
    return;
  }
  expect(mocks.writeHead).toHaveBeenLastCalledWith(status, { "Content-Type": "application/json" });
  expect(JSON.parse(String(mocks.end.mock.calls.at(-1)?.[0]))).toEqual(payload);
}

describe("persistence read route boundaries", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      if (typeof mock === "function" && "mockClear" in mock) mock.mockClear();
    }
    mocks.exists.mockReturnValue(true);
    mocks.projectExists.mockResolvedValue(true);
    mocks.projectIdentity.mockImplementation((cwd: string) => ({ id: cwd, canonical: cwd }));
    mocks.validate.mockImplementation((cwd: string) => cwd);
    mocks.describe.mockResolvedValue({ id: "node" });
    mocks.expand.mockResolvedValue({ expanded: ["node"] });
    mocks.grep.mockResolvedValue({ messages: [], summaries: [], matches: [] });
    mocks.getConnection.mockReturnValue({ prepare: () => ({ all: mocks.dbAll }) });
    mocks.dbAll.mockReturnValue([]);
    mocks.poolStats.mockReturnValue({ totalConnections: 0 });
    mocks.stats.mockReturnValue({ projects: 0 });
    mocks.promotedSearch.mockReturnValue([]);
    mocks.recentSummaries.mockResolvedValue([]);
    const project = {
      conversations: {}, summaries: { listRecentSummaries: mocks.recentSummaries },
      largeFiles: {}, lexicalSearch: { searchPromoted: mocks.promotedSearch },
      close: mocks.projectClose,
    };
    mocks.openProject.mockResolvedValue(project);
    mocks.createFactory.mockImplementation(async () => injectedFactory());
  });

  it("covers describe validation, absence, success, and typed failures", async () => {
    const handler = createDescribeHandler(config);
    await invoke(handler, "");
    expectLast(400, { error: "nodeId is required" });
    mocks.validate.mockImplementationOnce(() => { throw new Error("bad cwd"); });
    await invoke(handler, { nodeId: "n", cwd: "/bad" });
    expectLast(200, { node: null });
    await invoke(handler, { nodeId: "n" });
    expectLast(200, { node: null });
    mocks.projectExists.mockResolvedValueOnce(false);
    await invoke(handler, { nodeId: "n", cwd: "/missing" });
    expectLast(200, { node: null });
    await invoke(handler, { nodeId: "n", cwd: "/ok" });
    expectLast(200, { node: { id: "node" } });
    expect(mocks.projectClose).toHaveBeenCalled();
    expect(mocks.factoryClose).toHaveBeenCalled();
    mocks.describe.mockRejectedValueOnce(new Error("describe broke"));
    await invoke(handler, { nodeId: "n", cwd: "/ok" });
    expectLast(200, { node: null, error: "describe broke" });
    expect(mocks.projectClose).toHaveBeenCalled();
    mocks.describe.mockRejectedValueOnce("failure");
    await invoke(handler, { nodeId: "n", cwd: "/ok" });
    expectLast(200, { node: null, error: "describe failed" });
    const ownedCloseCount = mocks.factoryClose.mock.calls.length;
    await invoke(createDescribeHandler(config, injectedFactory()), { nodeId: "n", cwd: "/ok" });
    expect(mocks.factoryClose).toHaveBeenCalledTimes(ownedCloseCount);
    mocks.describe.mockRejectedValueOnce(storageFailure("summaries", "describe"));
    await invoke(createDescribeHandler(postgresqlConfig(), postgresqlFactory(injectedFactory())), { nodeId: "n", cwd: "/ok" });
    expectLast(503, {
      ...storageFailure("summaries", "describe").toJSON(),
    });
  });

  it("uses the injected backend without consulting a local SQLite path", async () => {
    mocks.exists.mockReturnValue(false);
    mocks.projectExists.mockResolvedValue(true);
    const factory = postgresqlFactory(injectedFactory());
    await invoke(createDescribeHandler(postgresqlConfig(), factory), { nodeId: "n", cwd: "/remote" });
    expectLast(200, { node: { id: "node" } });
    expect(mocks.openProject).toHaveBeenCalledWith({ id: "/remote", canonical: "/remote" });
    expect(mocks.createFactory).not.toHaveBeenCalled();
  });

  it("does not emit a second response when both cleanup operations reject", async () => {
    mocks.projectClose.mockRejectedValueOnce(new Error("project close failed"));
    mocks.factoryClose.mockRejectedValueOnce(new Error("factory close failed"));
    const sendsBefore = mocks.send.mock.calls.length;
    await invoke(createDescribeHandler(config), { nodeId: "n", cwd: "/ok" });
    expect(mocks.send).toHaveBeenCalledTimes(sendsBefore + 1);
    expectLast(200, { node: { id: "node" } });
    expect(mocks.projectClose).toHaveBeenCalled();
    expect(mocks.factoryClose).toHaveBeenCalled();
  });

  it("covers expand validation, defaults, absence, success, and failures", async () => {
    const handler = createExpandHandler(config);
    await invoke(handler, "");
    expectLast(400, { error: "nodeId is required" });
    mocks.validate.mockImplementationOnce(() => { throw new Error("bad cwd"); });
    await invoke(handler, { nodeId: "n", cwd: "/bad" });
    expectLast(200, { expanded: null, error: "project not found" });
    await invoke(handler, { nodeId: "n" });
    expectLast(200, { expanded: null, error: "project not found" });
    mocks.projectExists.mockResolvedValueOnce(false);
    await invoke(handler, { nodeId: "n", cwd: "/missing" });
    expectLast(200, { expanded: null, error: "project not found" });
    await invoke(handler, { nodeId: "n", cwd: "/ok", depth: 3 });
    expect(mocks.expand).toHaveBeenLastCalledWith({ summaryIds: ["n"], maxDepth: 3 });
    mocks.expand.mockRejectedValueOnce(new Error("expand broke"));
    await invoke(handler, { nodeId: "n", cwd: "/ok" });
    expectLast(200, { expanded: null, error: "expand broke" });
    expect(mocks.projectClose).toHaveBeenCalled();
    mocks.expand.mockRejectedValueOnce("failure");
    await invoke(handler, { nodeId: "n", cwd: "/ok" });
    expectLast(200, { expanded: null, error: "expansion failed" });
    await invoke(createExpandHandler(config, injectedFactory()), { nodeId: "n", cwd: "/ok" });
    const failure = storageFailure("summaries", "expand");
    mocks.expand.mockRejectedValueOnce(failure);
    await invoke(createExpandHandler(postgresqlConfig(), postgresqlFactory(injectedFactory())), { nodeId: "n", cwd: "/ok" });
    expectLast(503, {
      ...failure.toJSON(),
    });
  });

  it("covers grep validation, defaults, missing projects, success, and failure", async () => {
    const handler = createGrepHandler(config);
    await invoke(handler, "");
    expectLast(400, { error: "query is required" });
    await invoke(handler, { query: "q" });
    expectLast(200, { matches: [] });
    mocks.validate.mockImplementationOnce(() => { throw new Error("bad cwd"); });
    await invoke(handler, { query: "q", cwd: "/bad" });
    expectLast(200, { matches: [] });
    mocks.projectExists.mockResolvedValueOnce(false);
    await invoke(handler, { query: "q", cwd: "/missing" });
    expectLast(200, { matches: [] });
    await invoke(handler, { query: "q", cwd: "/ok" });
    expect(mocks.grep).toHaveBeenLastCalledWith({ query: "q", mode: "full_text", scope: "both", since: undefined });
    await invoke(handler, { query: "q", cwd: "/ok", mode: "regex", scope: "messages", since: "2025" });
    expect(mocks.grep).toHaveBeenLastCalledWith({ query: "q", mode: "regex", scope: "messages", since: "2025" });
    mocks.grep.mockRejectedValueOnce(new Error("grep broke"));
    await invoke(handler, { query: "q", cwd: "/ok" });
    expectLast(200, { matches: [] });
    await invoke(createGrepHandler(config, injectedFactory()), { query: "q", cwd: "/ok" });
    const failure = storageFailure("lexical-search", "grep");
    mocks.grep.mockRejectedValueOnce(failure);
    await invoke(createGrepHandler(postgresqlConfig(), postgresqlFactory(injectedFactory())), { query: "q", cwd: "/ok" });
    expectLast(503, {
      ...failure.toJSON(),
    });
  });

  it("covers recent validation, missing projects, defaults, success, and failure", async () => {
    const handler = createRecentHandler(config);
    await invoke(handler, "");
    expectLast(200, { summaries: [] });
    mocks.validate.mockImplementationOnce(() => { throw new Error("bad cwd"); });
    await invoke(handler, { cwd: "/bad" });
    expectLast(200, { summaries: [] });
    mocks.projectExists.mockResolvedValueOnce(false);
    await invoke(handler, { cwd: "/missing" });
    expectLast(200, { summaries: [] });
    const previousTimezone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      mocks.recentSummaries.mockResolvedValueOnce([{
        summaryId: "s", content: "summary", depth: 1, tokenCount: 2,
        // SQLite CURRENT_TIMESTAMP is UTC, including local DST gaps.
        createdAt: new Date("2024-03-10T02:30:00Z"),
      }]);
      await invoke(handler, { cwd: "/ok", limit: 2 });
      expectLast(200, { summaries: [{ summary_id: "s", content: "summary", depth: 1, token_count: 2, created_at: "2024-03-10 02:30:00" }] });
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
    expect(mocks.recentSummaries).toHaveBeenLastCalledWith(2);
    await invoke(handler, { cwd: "/ok" });
    expect(mocks.recentSummaries).toHaveBeenLastCalledWith(5);
    mocks.recentSummaries.mockRejectedValueOnce(new Error("query failed"));
    await invoke(handler, { cwd: "/ok" });
    expectLast(200, { summaries: [] });
    await invoke(createRecentHandler(config, injectedFactory()), { cwd: "/ok" });
    const failure = storageFailure("summaries", "recent");
    mocks.recentSummaries.mockRejectedValueOnce(failure);
    await invoke(createRecentHandler(postgresqlConfig(), postgresqlFactory(injectedFactory())), { cwd: "/ok" });
    expectLast(503, {
      ...failure.toJSON(),
    });
  });

  it("covers pool and aggregate stats success and failure payloads", async () => {
    await invoke(createPoolStatsHandler(), {});
    expectLast(200, { totalConnections: 0 });
    mocks.poolStats.mockImplementationOnce(() => { throw new Error("pool broke"); });
    await invoke(createPoolStatsHandler(), {});
    expectLast(500, { error: "pool broke" });
    mocks.poolStats.mockImplementationOnce(() => { throw "failure"; });
    await invoke(createPoolStatsHandler(), {});
    expectLast(500, { error: "pool stats failed" });

    await invoke(createStatsHandler(), {});
    expectLast(200, { projects: 0 });
    mocks.stats.mockImplementationOnce(() => { throw new Error("stats broke"); });
    await invoke(createStatsHandler(), {});
    expectLast(500, { error: "Stats collection failed" });
  });

  it("covers layered search validation, filtering, failures, and disabled layers", async () => {
    const handler = createSearchHandler(config);
    await invoke(handler, "");
    expectLast(400, { error: "query is required" });
    mocks.validate.mockImplementationOnce(() => { throw new Error("bad cwd"); });
    await invoke(handler, { query: "q", cwd: "/bad" });
    expectLast(400, { error: "bad cwd" });
    mocks.validate.mockImplementationOnce(() => { throw "failure"; });
    await invoke(handler, { query: "q", cwd: "/bad" });
    expectLast(400, { error: "invalid cwd" });
    await invoke(handler, { query: "q" });
    expectLast(200, { episodic: [], promoted: [] });
    mocks.projectExists.mockResolvedValueOnce(false);
    await invoke(handler, { query: "q", cwd: "/missing" });
    expectLast(200, { episodic: [], promoted: [] });

    mocks.grep.mockResolvedValueOnce({
      messages: [{ id: "match", tags: ["a", "b"] }, { id: "wrong", tags: ["b"] }],
      summaries: [{ id: "untagged", tags: "a" }],
      matches: [],
    });
    mocks.promotedSearch.mockResolvedValueOnce([{ id: "promoted" }]);
    await invoke(handler, { query: "q", cwd: "/ok", tags: ["a"], limit: 1 });
    expectLast(200, { episodic: [{ id: "match", tags: ["a", "b"] }], promoted: [{ id: "promoted" }] });
    expect(mocks.promotedSearch).toHaveBeenLastCalledWith("q", 1, ["a"]);

    mocks.grep.mockResolvedValueOnce({ messages: [{ id: "all" }], summaries: [], matches: [] });
    await invoke(handler, { query: "q", cwd: "/ok", tags: [], layers: ["episodic"] });
    expectLast(200, { episodic: [{ id: "all" }], promoted: [] });
    await invoke(handler, { query: "q", cwd: "/ok", tags: "invalid", layers: [] });
    expectLast(200, { episodic: [], promoted: [] });

    mocks.grep.mockRejectedValueOnce(new Error("grep failed"));
    mocks.promotedSearch.mockRejectedValueOnce(new Error("promoted failed"));
    await invoke(handler, { query: "q", cwd: "/ok" });
    expectLast(200, { episodic: [], promoted: [] });
    mocks.openProject.mockRejectedValueOnce(new Error("open failed"));
    await invoke(handler, { query: "q", cwd: "/ok" });
    expectLast(200, { episodic: [], promoted: [] });
    await invoke(createSearchHandler(config, injectedFactory()), { query: "q", cwd: "/ok", layers: [] });

    const stagedFactory = postgresqlFactory(injectedFactory());
    const openFailure = storageFailure("factory", "openExistingProject");
    vi.spyOn(stagedFactory, "openExistingProject").mockRejectedValueOnce(openFailure);
    await invoke(createSearchHandler(postgresqlConfig(), stagedFactory), { query: "q", cwd: "/ok" });
    expectLast(503, {
      ...openFailure.toJSON(),
    });

    const nonStorageFailure = postgresqlFactory(injectedFactory());
    vi.spyOn(nonStorageFailure, "openExistingProject")
      .mockRejectedValueOnce(new Error("unrelated failure"));
    await invoke(createSearchHandler(config, nonStorageFailure), { query: "q", cwd: "/ok" });
    expectLast(200, { episodic: [], promoted: [] });
  });

  it("rethrows typed PostgreSQL failures from both layered search operations", async () => {
    const factory = postgresqlFactory(injectedFactory());
    const episodicFailure = storageFailure("lexical-search", "search-messages");
    mocks.grep.mockRejectedValueOnce(episodicFailure);
    await invoke(createSearchHandler(postgresqlConfig(), factory), { query: "q", cwd: "/ok" });
    expectLast(503, { ...episodicFailure.toJSON() });

    const promotedFailure = storageFailure("lexical-search", "search-promoted");
    mocks.promotedSearch.mockRejectedValueOnce(promotedFailure);
    await invoke(createSearchHandler(postgresqlConfig(), factory), { query: "q", cwd: "/ok", layers: ["promoted"] });
    expectLast(503, { ...promotedFailure.toJSON() });
  });

  it("validates every manual read request before selected storage admission", async () => {
    const openExistingProject = vi.fn(async () => {
      throw new Error("storage admission should not run for invalid input");
    });
    const factory = { ...postgresqlFactory(injectedFactory()), openExistingProject };
    const cases = [
      [createSearchHandler(postgresqlConfig(), factory), { query: "q", cwd: "/invalid" }],
      [createGrepHandler(postgresqlConfig(), factory), { query: "q", cwd: "/invalid" }],
      [createRecentHandler(postgresqlConfig(), factory), { cwd: "/invalid" }],
      [createDescribeHandler(postgresqlConfig(), factory), { nodeId: "n", cwd: "/invalid" }],
      [createExpandHandler(postgresqlConfig(), factory), { nodeId: "n", cwd: "/invalid" }],
    ] as const;

    for (const [handler, body] of cases) {
      mocks.validate.mockImplementationOnce(() => { throw new Error("invalid cwd"); });
      await invoke(handler, body);
    }

    expect(openExistingProject).not.toHaveBeenCalled();
  });

  it("passes the live publication token and request cancellation into read storage", async () => {
    const token = {} as never;
    const openExistingProject = vi.fn(async (_identity: unknown, observedToken: unknown): Promise<ProjectStorage> => ({
      close: mocks.projectClose,
      observedToken,
    } as unknown as ProjectStorage));
    const factory = { ...injectedFactory(), openExistingProject };
    const controller = new AbortController();
    let release: ((value: { id: string }) => void) | undefined;
    mocks.describe.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));

    const pending = invoke(
      createDescribeHandler(config, factory),
      { nodeId: "n", cwd: "/ok" },
      { publicationLockToken: token, signal: controller.signal },
    );
    await vi.waitFor(() => expect(openExistingProject).toHaveBeenCalled());
    expect(mocks.projectIdentity).toHaveBeenCalledWith("/ok", config.storage, token);
    expect(openExistingProject).toHaveBeenCalledWith({ id: "/ok", canonical: "/ok" }, token);
    controller.abort();
    await vi.waitFor(() => expect(mocks.projectClose).toHaveBeenCalled());
    release?.({ id: "node" });
    await pending;
  });

  it.each([
    ["unbound project", new StorageIdentityConfigurationError("project binding is required")],
    [
      "unregistered machine",
      new MachineIdentityFileError(
        "machine identity is not registered",
        "Run `lcm machine register` before linking a PostgreSQL project.",
      ),
    ],
  ])("returns structured identity admission failures for every manual read route: %s", async (
    _case,
    identityError,
  ) => {
    for (const [handler, body] of [
      [createSearchHandler(config), { query: "q", cwd: "/ok" }],
      [createGrepHandler(config), { query: "q", cwd: "/ok" }],
      [createRecentHandler(config), { cwd: "/ok" }],
      [createDescribeHandler(config), { nodeId: "n", cwd: "/ok" }],
      [createExpandHandler(config), { nodeId: "n", cwd: "/ok" }],
    ] as const) {
      mocks.projectIdentity.mockImplementationOnce(() => {
        throw identityError;
      });
      await invoke(handler, body);
      expectLast(409, {
        code: "STORAGE_IDENTITY_REQUIRED",
        error: identityError instanceof MachineIdentityFileError
          ? "Machine identity is unavailable. Run `lcm machine show` for recovery guidance."
          : identityError.message,
        storageBackend: "postgresql",
      });
    }
  });
});
