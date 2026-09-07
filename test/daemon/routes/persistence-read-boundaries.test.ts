import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { loadDaemonConfig, type DaemonConfig } from "../../../src/daemon/config.js";
import { sanitizeError } from "../../../src/daemon/safe-error.js";
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
  getConversationBySessionId: vi.fn(async () => null),
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
vi.mock("../../../src/retrieval.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/retrieval.js")>(),
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
vi.mock("../../../src/stats.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/stats.js")>(), collectStats: mocks.stats,
}));


import { backendDiagnosticFailure } from "../../../src/storage/diagnostics.js";
import { BackendPublicationJournalError } from "../../../src/storage/backend-publication.js";
import { StatsUnavailableError } from "../../../src/stats.js";
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
    mocks.getConversationBySessionId.mockResolvedValue(null);
    const project = {
      conversations: { getConversationBySessionId: mocks.getConversationBySessionId }, summaries: { listRecentSummaries: mocks.recentSummaries },
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
    mocks.describe.mockRejectedValueOnce(new Error("SQLITE_CONSTRAINT at /private/describe.db"));
    await invoke(handler, { nodeId: "n", cwd: "/ok" });
    expectLast(200, { node: null, error: "database constraint error" });
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

  it("sanitizes nested file URLs in describe read errors", async () => {
    mocks.describe.mockRejectedValueOnce(
      new Error("read failed for https://outer.test/x?next=file://host.invalid/Users/canary/private.db"),
    );
    await invoke(createDescribeHandler(config), { nodeId: "n", cwd: "/ok" });
    expectLast(200, {
      node: null,
      error: "read failed for https://outer.test/x?next=file://host.invalid<path>",
    });
  });

  it("sanitizes nested file URLs in expand read errors", async () => {
    mocks.expand.mockRejectedValueOnce(
      new Error("expand failed for https://outer.test/x?next=file://host.invalid/Users/canary/private.db"),
    );
    await invoke(createExpandHandler(config), { nodeId: "n", cwd: "/ok" });
    expect(mocks.expand).toHaveBeenCalled();
    expectLast(200, {
      expanded: null,
      error: "expand failed for https://outer.test/x?next=file://host.invalid<path>",
    });
  });

  it("preserves adjacent nested file URL schemes in describe wire errors", async () => {
    mocks.describe.mockRejectedValueOnce(
      new Error(
        "read failed for https://outer.test/x?q=file://h.invalid/Users/a-file://h2.invalid/Users/b",
      ),
    );
    await invoke(createDescribeHandler(config), { nodeId: "n", cwd: "/ok" });
    expectLast(200, {
      node: null,
      error: "read failed for https://outer.test/x?q=file://h.invalid<path>file://h2.invalid<path>",
    });
  });

  it("preserves adjacent nested file URL schemes in expand wire errors", async () => {
    mocks.expand.mockRejectedValueOnce(
      new Error(
        "expand failed for https://outer.test/x?q=file://h.invalid/Users/a-file://h2.invalid/Users/b",
      ),
    );
    await invoke(createExpandHandler(config), { nodeId: "n", cwd: "/ok" });
    expect(mocks.expand).toHaveBeenCalled();
    expectLast(200, {
      expanded: null,
      error: "expand failed for https://outer.test/x?q=file://h.invalid<path>file://h2.invalid<path>",
    });
  });

  it("absorbs an adjacent file suffix in describe wire errors", async () => {
    const message =
      "read failed for https://outer.test/x?q=file://h.invalid/Users/afile://h2.invalid/Users/b";
    const expected = "read failed for https://outer.test/x?q=file://h.invalid<path>";
    mocks.describe.mockRejectedValueOnce(new Error(message));

    expect(sanitizeError(message)).toBe(expected);
    await invoke(createDescribeHandler(config), { nodeId: "n", cwd: "/ok" });
    expectLast(200, { node: null, error: expected });
  });

  it("absorbs an adjacent file suffix in expand wire errors", async () => {
    const message = "expand failed for file://host.invalid?x=a\\Users\\a-file://h2.invalid/Users/b";
    const expected = "expand failed for file://host.invalid?x=a<path>";
    mocks.expand.mockRejectedValueOnce(new Error(message));

    expect(sanitizeError(message)).toBe(expected);
    await invoke(createExpandHandler(config), { nodeId: "n", cwd: "/ok" });
    expect(mocks.expand).toHaveBeenCalled();
    expectLast(200, { expanded: null, error: expected });
  });

  it("sanitizes adjacent post-bracket paths in describe read errors", async () => {
    mocks.describe.mockRejectedValueOnce(
      new Error("read failed for file://host.invalid[/Users/canary/one.db]/Users/canary/two.db"),
    );
    await invoke(createDescribeHandler(config), { nodeId: "n", cwd: "/ok" });
    expectLast(200, {
      node: null,
      error: "read failed for file://host.invalid[<path>]<path>",
    });
  });

  it("sanitizes adjacent post-bracket paths in expand read errors", async () => {
    mocks.expand.mockRejectedValueOnce(
      new Error("expand failed for file://host.invalid[/Users/canary/one.db]/Users/canary/two.db"),
    );
    await invoke(createExpandHandler(config), { nodeId: "n", cwd: "/ok" });
    expect(mocks.expand).toHaveBeenCalled();
    expectLast(200, {
      expanded: null,
      error: "expand failed for file://host.invalid[<path>]<path>",
    });
  });

  it("uses the injected backend without consulting a local SQLite path", async () => {
    mocks.exists.mockReturnValue(false);
    mocks.projectExists.mockResolvedValue(true);
    const factory = postgresqlFactory(injectedFactory());
    await invoke(createDescribeHandler(postgresqlConfig(), factory), { nodeId: "n", cwd: "/remote" });
    expectLast(200, { node: { id: "node" } });
    expect(mocks.openProject).toHaveBeenCalledWith({ id: "/remote", canonical: "/remote" }, undefined, expect.any(AbortSignal));
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
    expectLast(200, { expanded: ["node"] });
    mocks.expand.mockRejectedValueOnce(new Error("expand failed at C:\\Users\\operator\\private.db"));
    await invoke(handler, { nodeId: "n", cwd: "/ok" });
    expectLast(200, { expanded: null, error: "expand failed at <path>" });
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

  it("rejects malformed expand depths before cwd and storage admission", async () => {
    const malformed = [
      '{"nodeId":"n","cwd":"/ok","depth":null}',
      '{"nodeId":"n","cwd":"/ok","depth":"1"}',
      '{"nodeId":"n","cwd":"/ok","depth":true}',
      '{"nodeId":"n","cwd":"/ok","depth":false}',
      '{"nodeId":"n","cwd":"/ok","depth":[]}',
      '{"nodeId":"n","cwd":"/ok","depth":{}}',
      '{"nodeId":"n","cwd":"/ok","depth":0}',
      '{"nodeId":"n","cwd":"/ok","depth":-0}',
      '{"nodeId":"n","cwd":"/ok","depth":-1}',
      '{"nodeId":"n","cwd":"/ok","depth":1.5}',
      '{"nodeId":"n","cwd":"/ok","depth":1e400}',
      '{"nodeId":"n","cwd":"/ok","depth":-1e400}',
      '{"nodeId":"n","depth":null}',
      '{"nodeId":"n","cwd":"/bad","depth":1e400}',
    ];
    const handlers = [
      createExpandHandler(config),
      createExpandHandler(postgresqlConfig(), postgresqlFactory(injectedFactory())),
    ];

    for (const handler of handlers) {
      for (const body of malformed) {
        mocks.send.mockClear();
        mocks.writeHead.mockClear();
        mocks.end.mockClear();
        mocks.validate.mockClear();
        mocks.projectIdentity.mockClear();
        mocks.projectExists.mockClear();
        mocks.openProject.mockClear();
        mocks.createFactory.mockClear();
        mocks.expand.mockClear();

        await invoke(handler, body);

        expectLast(400, { error: "invalid depth" });
        expect(mocks.validate).not.toHaveBeenCalled();
        expect(mocks.projectIdentity).not.toHaveBeenCalled();
        expect(mocks.projectExists).not.toHaveBeenCalled();
        expect(mocks.openProject).not.toHaveBeenCalled();
        expect(mocks.createFactory).not.toHaveBeenCalled();
        expect(mocks.expand).not.toHaveBeenCalled();
      }
    }
  });

  it("rejects non-object expand bodies before cwd and storage admission", async () => {
    const openExistingProject = vi.fn(async () => {
      throw new Error("storage admission should not run for invalid body shape");
    });
    const factory = { ...postgresqlFactory(injectedFactory()), openExistingProject };
    const handlers = [
      createExpandHandler(config),
      createExpandHandler(postgresqlConfig(), factory),
    ];
    const bodies = ["null", "[]", "\"text\"", "1", "true", "false"];

    for (const handler of handlers) {
      for (const body of bodies) {
        mocks.send.mockClear();
        mocks.writeHead.mockClear();
        mocks.end.mockClear();
        mocks.validate.mockClear();
        mocks.projectIdentity.mockClear();
        mocks.projectExists.mockClear();
        mocks.openProject.mockClear();
        mocks.createFactory.mockClear();
        mocks.expand.mockClear();

        await expect(invoke(handler, body)).resolves.toBeUndefined();

        expectLast(400, { error: "invalid request body" });
        expect(mocks.validate).not.toHaveBeenCalled();
        expect(mocks.projectIdentity).not.toHaveBeenCalled();
        expect(mocks.projectExists).not.toHaveBeenCalled();
        expect(mocks.openProject).not.toHaveBeenCalled();
        expect(mocks.createFactory).not.toHaveBeenCalled();
        expect(mocks.expand).not.toHaveBeenCalled();
        expect(openExistingProject).not.toHaveBeenCalled();
      }
    }
  });

  it("preserves expand JSON syntax errors and object validation", async () => {
    await expect(invoke(createExpandHandler(config), "{"))
      .rejects.toBeInstanceOf(SyntaxError);

    await invoke(createExpandHandler(config), "{}");
    expectLast(400, { error: "nodeId is required" });
  });

  it("preserves nodeId precedence when depth is invalid", async () => {
    const handler = createExpandHandler(config);
    await invoke(handler, '{"cwd":"/bad","depth":null}');
    expectLast(400, { error: "nodeId is required" });
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.projectIdentity).not.toHaveBeenCalled();
    expect(mocks.expand).not.toHaveBeenCalled();
  });

  it("forwards omitted and positive integer depths unchanged", async () => {
    const handler = createExpandHandler(config);
    for (const [body, expected] of [
      ['{"nodeId":"n","cwd":"/ok"}', 1],
      ['{"nodeId":"n","cwd":"/ok","depth":1}', 1],
      ['{"nodeId":"n","cwd":"/ok","depth":2}', 2],
      ['{"nodeId":"n","cwd":"/ok","depth":9007199254740991}', 9007199254740991],
    ] as const) {
      mocks.expand.mockClear();
      await invoke(handler, body);
      expectLast(200, { expanded: ["node"] });
      expect(mocks.expand).toHaveBeenLastCalledWith({ summaryIds: ["n"], maxDepth: expected });
    }
  });

  it("covers grep validation, defaults, missing projects, success, and failure", async () => {
    const handler = createGrepHandler(config);
    await invoke(handler, "");
    expectLast(400, { error: "query is required" });
    await invoke(handler, { query: "q", scope: "invalid" });
    expectLast(400, { error: "invalid scope" });
    mocks.validate.mockClear();
    await invoke(handler, { query: "q", cwd: "/bad", scope: "invalid" });
    expectLast(400, { error: "invalid scope" });
    expect(mocks.validate).not.toHaveBeenCalled();
    for (const mode of [null, 1, [], {}, "unknown"]) {
      mocks.validate.mockClear();
      const projectExistsCalls = mocks.projectExists.mock.calls.length;
      await invoke(handler, { query: "q", cwd: "/bad", mode });
      expectLast(400, { error: "invalid mode" });
      expect(mocks.validate).not.toHaveBeenCalled();
      expect(mocks.projectExists.mock.calls.length).toBe(projectExistsCalls);
    }
    mocks.validate.mockClear();
    const projectExistsCalls = mocks.projectExists.mock.calls.length;
    await invoke(handler, { query: "q", cwd: "/bad", mode: null, scope: "invalid" });
    expectLast(400, { error: "invalid mode" });
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.projectExists.mock.calls.length).toBe(projectExistsCalls);
    await invoke(handler, { query: "q", scope: "all" });
    expectLast(200, { matches: [] });
    await invoke(handler, { query: "q" });
    expectLast(200, { matches: [] });
    mocks.validate.mockImplementationOnce(() => { throw new Error("bad cwd"); });
    await invoke(handler, { query: "q", cwd: "/bad" });
    expectLast(200, { matches: [] });
    mocks.validate.mockImplementationOnce(() => { throw new Error("bad cwd"); });
    await invoke(handler, { query: "q", cwd: "/bad", sessionId: "session" });
    expectLast(200, { matches: [] });
    mocks.projectExists.mockResolvedValueOnce(false);
    await invoke(handler, { query: "q", cwd: "/missing" });
    expectLast(200, { matches: [] });
    mocks.projectExists.mockResolvedValueOnce(false);
    await invoke(handler, { query: "q", cwd: "/missing", sessionId: "session" });
    expectLast(200, { matches: [] });
    await invoke(handler, { query: "q", cwd: "/ok" });
    expect(mocks.grep).toHaveBeenLastCalledWith({ query: "q", mode: "full_text", scope: "both", since: undefined });
    expect(mocks.getConversationBySessionId).not.toHaveBeenCalled();
    await invoke(handler, { query: "q", cwd: "/ok", mode: "full_text", scope: "messages" });
    expect(mocks.grep).toHaveBeenLastCalledWith({ query: "q", mode: "full_text", scope: "messages", since: undefined });
    await invoke(handler, {
      query: "q",
      cwd: "/ok",
      mode: "regex",
      scope: "messages",
      since: "2025-01-02T03:04:05.006+05:30",
    });
    expect(mocks.grep).toHaveBeenLastCalledWith({
      query: "q",
      mode: "regex",
      scope: "messages",
      since: new Date("2025-01-01T21:34:05.006Z"),
    });
    await invoke(handler, { query: "q", cwd: "/ok", scope: "summaries" });
    expect(mocks.grep).toHaveBeenLastCalledWith({ query: "q", mode: "full_text", scope: "summaries", since: undefined });
    await invoke(handler, { query: "q", cwd: "/ok", scope: "all" });
    expect(mocks.grep).toHaveBeenLastCalledWith({ query: "q", mode: "full_text", scope: "both", since: undefined });
    const sessionId = " exact-session-id ";
    mocks.getConversationBySessionId.mockResolvedValueOnce({ conversationId: 42, sessionId } as never);
    await invoke(handler, { query: "q", cwd: "/ok", sessionId, scope: "messages" });
    expect(mocks.getConversationBySessionId).toHaveBeenLastCalledWith(sessionId);
    expect(mocks.grep).toHaveBeenLastCalledWith({
      query: "q", mode: "full_text", scope: "messages", since: undefined, conversationId: 42,
    });
    mocks.getConversationBySessionId.mockResolvedValueOnce(null);
    mocks.grep.mockClear();
    await invoke(handler, { query: "q", cwd: "/ok", sessionId: "unknown" });
    expectLast(200, { messages: [], summaries: [], totalMatches: 0 });
    expect(mocks.grep).not.toHaveBeenCalled();
    const malformedSessionIds: unknown[] = [null, [], {}, false, 1, "", "   ", "bad\0session"];
    for (const malformed of malformedSessionIds) {
      mocks.validate.mockClear();
      const openCalls = mocks.openProject.mock.calls.length;
      await invoke(handler, { query: "q", cwd: "/ok", sessionId: malformed });
      expectLast(400, { error: "invalid sessionId" });
      expect(mocks.validate).not.toHaveBeenCalled();
      expect(mocks.openProject.mock.calls.length).toBe(openCalls);
    }
    mocks.grep.mockRejectedValueOnce(new Error("grep broke"));
    await invoke(handler, { query: "q", cwd: "/ok" });
    expectLast(200, { matches: [] });
    mocks.getConversationBySessionId.mockRejectedValueOnce(new Error("session lookup broke"));
    await invoke(handler, { query: "q", cwd: "/ok", sessionId: "lookup-failure" });
    expectLast(200, { matches: [] });
    expect(mocks.projectClose).toHaveBeenCalled();
    const lookupStorageFailure = new StorageOperationError(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      "/ok",
      "conversations",
      "getConversationBySessionId",
    );
    mocks.getConversationBySessionId.mockRejectedValueOnce(lookupStorageFailure);
    await invoke(
      createGrepHandler(postgresqlConfig(), postgresqlFactory(injectedFactory())),
      { query: "q", cwd: "/ok", sessionId: "lookup-storage-failure" },
    );
    expectLast(503, { ...lookupStorageFailure.toJSON() });
    expect(mocks.projectClose).toHaveBeenCalled();
    await invoke(createGrepHandler(config, injectedFactory()), { query: "q", cwd: "/ok" });
    const failure = storageFailure("lexical-search", "grep");
    mocks.grep.mockRejectedValueOnce(failure);
    await invoke(createGrepHandler(postgresqlConfig(), postgresqlFactory(injectedFactory())), { query: "q", cwd: "/ok" });
    expectLast(503, {
      ...failure.toJSON(),
    });
  });

  it("normalizes supported UTC years and rejects invalid since values before storage", async () => {
    const handler = createGrepHandler(config);
    const valid = [
      ["0001-01-01T00:00:00Z", "0001-01-01T00:00:00.000Z"],
      ["0000-12-31T23:00:00-01:00", "0001-01-01T00:00:00.000Z"],
      ["0001-01-01T00:01:00+00:01", "0001-01-01T00:00:00.000Z"],
      ["2024-02-29T23:59:59Z", "2024-02-29T23:59:59.000Z"],
      ["2000-02-29T00:00:00Z", "2000-02-29T00:00:00.000Z"],
      ["2025-01-01T00:00:00+23:59", "2024-12-31T00:01:00.000Z"],
      ["2025-12-31T23:59:59.1-02:30", "2026-01-01T02:29:59.100Z"],
      ["2025-06-15T12:34:56.999Z", "2025-06-15T12:34:56.999Z"],
      ["9999-12-31T23:59:59.999Z", "9999-12-31T23:59:59.999Z"],
      ["9999-12-31T23:58:59.999-00:01", "9999-12-31T23:59:59.999Z"],
      ["9999-12-31T22:59:59.999-01:00", "9999-12-31T23:59:59.999Z"],
    ] as const;

    for (const [input, expected] of valid) {
      await invoke(handler, { query: "q", cwd: "/ok", since: input });
      const since = mocks.grep.mock.calls.at(-1)?.[0].since;
      expect(since).toBeInstanceOf(Date);
      expect((since as Date).toISOString()).toBe(expected);
    }

    mocks.getConversationBySessionId.mockResolvedValueOnce({ conversationId: 42 } as never);
    await invoke(handler, {
      query: "q",
      cwd: "/ok",
      sessionId: "session",
      since: "2025-01-01T00:00:00Z",
    });
    const sessionSince = mocks.grep.mock.calls.at(-1)?.[0].since;
    expect(sessionSince).toBeInstanceOf(Date);
    expect((sessionSince as Date).toISOString()).toBe("2025-01-01T00:00:00.000Z");

    await invoke(
      createGrepHandler(postgresqlConfig(), postgresqlFactory(injectedFactory())),
      { query: "q", cwd: "/ok", since: "2025-01-01T00:00:00Z" },
    );
    const postgresqlSince = mocks.grep.mock.calls.at(-1)?.[0].since;
    expect(postgresqlSince).toBeInstanceOf(Date);
    expect((postgresqlSince as Date).toISOString()).toBe("2025-01-01T00:00:00.000Z");

    const canonical = (postgresqlSince as Date).toISOString();
    await invoke(handler, { query: "q", cwd: "/ok", since: canonical });
    expect((mocks.grep.mock.calls.at(-1)?.[0].since as Date).toISOString()).toBe(canonical);

    const malformed: unknown[] = [
      null,
      1,
      [],
      {},
      "",
      "   ",
      "2025",
      "2025-01-01",
      "2025-01-01T00:00:00",
      "2025-01-00T00:00:00Z",
      "2025-01-01T00:00:00.1234Z",
      "2025-01-01T00:00:00Zjunk",
      "2025-00-01T00:00:00Z",
      "2025-13-01T00:00:00Z",
      "2025-02-29T00:00:00Z",
      "1900-02-29T00:00:00Z",
      "2024-02-30T00:00:00Z",
      "2025-04-31T00:00:00Z",
      "2025-01-01T24:00:00Z",
      "2025-01-01T00:60:00Z",
      "2025-01-01T00:00:60Z",
      "2025-01-01T00:00:00+24:00",
      "2025-01-01T00:00:00+00:60",
      "0000-12-31T23:59:59.999Z",
      "0001-01-01T00:00:00+00:01",
      "0000-01-01T00:00:00Z",
      "0000-02-29T00:00:00Z",
      "0000-01-01T00:00:00+00:01",
      "9999-12-31T23:59:00.000-00:01",
      "9999-12-31T23:59:59.999-00:01",
    ];
    const handlers = [
      handler,
      createGrepHandler(postgresqlConfig(), postgresqlFactory(injectedFactory())),
    ];
    for (const candidate of handlers) {
      for (const since of malformed) {
        mocks.validate.mockClear();
        const openCalls = mocks.openProject.mock.calls.length;
        const grepCalls = mocks.grep.mock.calls.length;
        await invoke(candidate, { query: "q", cwd: "/bad", since });
        expectLast(400, { error: "invalid since" });
        expect(mocks.validate).not.toHaveBeenCalled();
        expect(mocks.openProject.mock.calls.length).toBe(openCalls);
        expect(mocks.grep.mock.calls.length).toBe(grepCalls);
      }
    }

    await invoke(handler, {
      query: "q",
      cwd: "/bad",
      sessionId: null,
      since: "not-a-date",
    });
    expectLast(400, { error: "invalid sessionId" });
    expect(mocks.validate).not.toHaveBeenCalled();
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

  it("rejects malformed recent limits before cwd and storage admission", async () => {
    const malformed = [
      '{"limit":null}',
      '{"cwd":"/bad","limit":null}',
      '{"cwd":"/ok","limit":null}',
      '{"cwd":"/ok","limit":"5"}',
      '{"cwd":"/ok","limit":true}',
      '{"cwd":"/ok","limit":{}}',
      '{"cwd":"/ok","limit":[]}',
      '{"cwd":"/ok","limit":0}',
      '{"cwd":"/ok","limit":-0}',
      '{"cwd":"/ok","limit":-1}',
      '{"cwd":"/ok","limit":1.5}',
      '{"cwd":"/ok","limit":1e400}',
      '{"cwd":"/ok","limit":-1e400}',
      '{"cwd":"/ok","limit":1001}',
    ];
    const handlers = [
      createRecentHandler(config),
      createRecentHandler(postgresqlConfig(), postgresqlFactory(injectedFactory())),
    ];

    for (const handler of handlers) {
      for (const body of malformed) {
        mocks.send.mockClear();
        mocks.writeHead.mockClear();
        mocks.end.mockClear();
        mocks.validate.mockClear();
        mocks.projectIdentity.mockClear();
        mocks.projectExists.mockClear();
        mocks.openProject.mockClear();
        mocks.recentSummaries.mockClear();
        mocks.createFactory.mockClear();

        await invoke(handler, body);

        expectLast(400, { error: "invalid limit" });
        expect(mocks.validate).not.toHaveBeenCalled();
        expect(mocks.projectIdentity).not.toHaveBeenCalled();
        expect(mocks.projectExists).not.toHaveBeenCalled();
        expect(mocks.openProject).not.toHaveBeenCalled();
        expect(mocks.recentSummaries).not.toHaveBeenCalled();
        expect(mocks.createFactory).not.toHaveBeenCalled();
      }
    }
  });

  it("forwards bounded recent limits and preserves valid cwd fallbacks", async () => {
    const handler = createRecentHandler(config);
    for (const [body, expected] of [
      [{ cwd: "/ok", limit: 1 }, 1],
      [{ cwd: "/ok", limit: 5 }, 5],
      [{ cwd: "/ok", limit: 1000 }, 1000],
      [{ cwd: "/ok" }, 5],
    ] as const) {
      mocks.recentSummaries.mockClear();
      await invoke(handler, body);
      expectLast(200, { summaries: [] });
      expect(mocks.recentSummaries).toHaveBeenLastCalledWith(expected);
    }

    mocks.recentSummaries.mockClear();
    await invoke(handler, { limit: 1 });
    expectLast(200, { summaries: [] });
    expect(mocks.recentSummaries).not.toHaveBeenCalled();

    mocks.validate.mockImplementationOnce(() => { throw new Error("bad cwd"); });
    await invoke(handler, { cwd: "/bad", limit: 1 });
    expectLast(200, { summaries: [] });
    expect(mocks.recentSummaries).not.toHaveBeenCalled();
  });

  it("returns common diagnostic snapshots and sanitizes aggregate failures", async () => {
    const diagnostics = backendDiagnosticFailure(new Error("private diagnostic canary"), "sqlite");
    const factory = injectedFactory();
    const controller = new AbortController();
    mocks.stats.mockReturnValueOnce({ projects: 0, backendDiagnostics: diagnostics } as never);
    await invoke(createPoolStatsHandler("/configured-home", factory), {}, { signal: controller.signal });
    expectLast(200, { backendDiagnostics: diagnostics });
    expect(mocks.stats).toHaveBeenCalledWith({ homeDir: "/configured-home", storageFactory: factory, signal: controller.signal });

    await invoke(createStatsHandler("/configured-home", factory), {}, { signal: controller.signal });
    expectLast(200, { projects: 0 });
    expect(mocks.stats).toHaveBeenCalledWith({ homeDir: "/configured-home", storageFactory: factory, signal: controller.signal });
    mocks.stats.mockImplementationOnce(() => { throw new Error("private diagnostic canary"); });
    await invoke(createStatsHandler(), {});
    expectLast(200, { backendDiagnostics: backendDiagnosticFailure(new Error("unobserved")) });
    mocks.stats.mockImplementationOnce(() => { throw new StatsUnavailableError(diagnostics); });
    await invoke(createStatsHandler(), {});
    expectLast(200, { backendDiagnostics: diagnostics });
    expect(JSON.stringify(mocks.end.mock.calls)).not.toContain("private diagnostic canary");
  });

  it("preserves configured backend identity across sanitized route failures", async () => {
    const unavailableDiagnostics = backendDiagnosticFailure(new Error("private unavailable"), "sqlite");
    const handlers = [
      ["stats", createStatsHandler],
      ["pool", createPoolStatsHandler],
    ] as const;
    const factories = [
      ["sqlite", injectedFactory()],
      ["postgresql", {...injectedFactory(),backend:"postgresql"} as StorageBackendFactory],
      ["unavailable", undefined],
    ] as const;
    const failures = [
      new Error("private error canary"),
      {private:"non-error canary"},
      new BackendPublicationJournalError("unexpected-state", "private publication canary"),
    ];
    for (const [_route, createHandler] of handlers) {
      for (const [backend, factory] of factories) {
        for (const failure of failures) {
          mocks.stats.mockImplementationOnce(() => { throw failure; });
          await invoke(createHandler("/configured-home", factory), {});
          const expected = backendDiagnosticFailure(failure, backend);
          expectLast(200, {backendDiagnostics:expected});
          expect(expected.metrics).toBeUndefined();
          expect(JSON.stringify(mocks.end.mock.calls.at(-1))).not.toMatch(/private|canary/);
        }
      }
    }

    for (const createHandler of [createStatsHandler,createPoolStatsHandler]) {
      mocks.stats.mockImplementationOnce(() => { throw new StatsUnavailableError(unavailableDiagnostics); });
      await invoke(createHandler("/configured-home", injectedFactory()), {});
      expectLast(200, {backendDiagnostics:unavailableDiagnostics});
    }
  });

  it("covers layered search validation, filtering, failures, and disabled layers", async () => {
    const handler = createSearchHandler(config);
    await invoke(handler, "");
    expectLast(400, { error: "query is required" });
    await invoke(handler, { query: "q", layers: ["invalid"] });
    expectLast(400, { error: "invalid layers" });
    await invoke(handler, { query: "q", layers: "episodic" });
    expectLast(400, { error: "invalid layers" });
    mocks.validate.mockClear();
    await invoke(handler, { query: "q", cwd: "/bad", layers: ["invalid"] });
    expectLast(400, { error: "invalid layers" });
    expect(mocks.validate).not.toHaveBeenCalled();
    await invoke(handler, { query: "q", layers: ["semantic"] });
    expectLast(200, { episodic: [], promoted: [] });
    expect(mocks.promotedSearch).not.toHaveBeenCalled();
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
      messages: [
        { messageId: 1, conversationId: 2, role: "user", snippet: "first", createdAt: new Date("2025-01-02") },
        { messageId: 2, conversationId: 2, role: "user", snippet: "second", createdAt: new Date("2025-01-01") },
      ],
      summaries: [{ summaryId: "untagged", conversationId: 2, kind: "leaf", snippet: "summary", createdAt: new Date("2024-12-31") }],
      matches: [],
    });
    mocks.promotedSearch.mockResolvedValueOnce([{ id: "promoted" }]);
    await invoke(handler, { query: "q", cwd: "/ok", tags: ["a"], limit: 2 });
    expectLast(200, {
      episodic: [
        { messageId: 1, conversationId: 2, role: "user", snippet: "first", createdAt: "2025-01-02T00:00:00.000Z" },
        { messageId: 2, conversationId: 2, role: "user", snippet: "second", createdAt: "2025-01-01T00:00:00.000Z" },
      ],
      promoted: [{ id: "promoted" }],
    });
    expect(mocks.grep).toHaveBeenLastCalledWith({ query: "q", mode: "full_text", scope: "both", limit: 50 });
    expect(mocks.promotedSearch).toHaveBeenLastCalledWith("q", 2, ["a"]);

    mocks.promotedSearch.mockResolvedValueOnce([{ id: "legacy-promoted" }]);
    await invoke(handler, { query: "q", cwd: "/ok", layers: ["semantic"] });
    expectLast(200, { episodic: [], promoted: [{ id: "legacy-promoted" }] });
    expect(mocks.promotedSearch).toHaveBeenLastCalledWith("q", 5, undefined);

    mocks.grep.mockResolvedValueOnce({
      messages: [{ messageId: 3, conversationId: 2, role: "user", snippet: "all", createdAt: new Date("2025-01-03") }],
      summaries: [],
      matches: [],
    });
    await invoke(handler, { query: "q", cwd: "/ok", tags: [], layers: ["episodic"] });
    expectLast(200, {
      episodic: [{ messageId: 3, conversationId: 2, role: "user", snippet: "all", createdAt: "2025-01-03T00:00:00.000Z" }],
      promoted: [],
    });
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

  it("rejects invalid search contracts before cwd or storage admission", async () => {
    const openExistingProject = vi.fn(async () => {
      throw new Error("storage admission should not run for invalid contract");
    });
    const factory = { ...postgresqlFactory(injectedFactory()), openExistingProject };
    mocks.validate.mockClear();
    await invoke(createSearchHandler(postgresqlConfig(), factory), { query: "q", cwd: "/bad", layers: ["nope"] });
    await invoke(createGrepHandler(postgresqlConfig(), factory), { query: "q", cwd: "/bad", scope: "nope" });
    expectLast(400, { error: "invalid scope" });
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(openExistingProject).not.toHaveBeenCalled();
  });

  it("passes the live publication token and request cancellation into read storage", async () => {
    const token = {} as never;
    const openExistingProject = vi.fn(async (_identity: unknown, observedToken: unknown, observedSignal: unknown): Promise<ProjectStorage> => ({
      close: mocks.projectClose,
      observedToken,
      observedSignal,
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
    expect(openExistingProject).toHaveBeenCalledWith({ id: "/ok", canonical: "/ok" }, token, controller.signal);
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
