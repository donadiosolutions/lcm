import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { loadDaemonConfig } from "../../../src/daemon/config.js";

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
}));
vi.mock("../../../src/daemon/server.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/daemon/server.js")>(),
  sendJson: mocks.send,
}));
vi.mock("../../../src/db/migration.js", () => ({ runLcmMigrations: mocks.migrate }));
vi.mock("../../../src/daemon/validate-cwd.js", () => ({ validateCwd: mocks.validate }));
vi.mock("../../../src/retrieval.js", () => ({
  RetrievalEngine: class {
    describe = mocks.describe;
    grep = mocks.grep;
  },
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
vi.mock("../../../src/stats.js", () => ({ collectStats: mocks.stats }));

import { createDescribeHandler } from "../../../src/daemon/routes/describe.js";
import { createExpandHandler } from "../../../src/daemon/routes/expand.js";
import { createGrepHandler } from "../../../src/daemon/routes/grep.js";
import { createRecentHandler } from "../../../src/daemon/routes/recent.js";
import { createPoolStatsHandler } from "../../../src/daemon/routes/pool-stats.js";
import { createStatsHandler } from "../../../src/daemon/routes/stats.js";
import { createSearchHandler } from "../../../src/daemon/routes/search.js";

const config = loadDaemonConfig("/tmp/lcm-persistence-routes");
const response = {
  writeHead: mocks.writeHead,
  end: mocks.end,
} as unknown as ServerResponse;

async function invoke(
  handler: ReturnType<typeof createDescribeHandler>,
  body: Record<string, unknown> | string,
): Promise<void> {
  await handler({} as never, response, typeof body === "string" ? body : JSON.stringify(body));
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
    mocks.validate.mockImplementation((cwd: string) => cwd);
    mocks.describe.mockResolvedValue({ id: "node" });
    mocks.expand.mockResolvedValue({ expanded: ["node"] });
    mocks.grep.mockResolvedValue({ messages: [], summaries: [], matches: [] });
    mocks.getConnection.mockReturnValue({ prepare: () => ({ all: mocks.dbAll }) });
    mocks.dbAll.mockReturnValue([]);
    mocks.poolStats.mockReturnValue({ totalConnections: 0 });
    mocks.stats.mockReturnValue({ projects: 0 });
    mocks.promotedSearch.mockReturnValue([]);
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
    mocks.exists.mockReturnValueOnce(false);
    await invoke(handler, { nodeId: "n", cwd: "/missing" });
    expectLast(200, { node: null });
    await invoke(handler, { nodeId: "n", cwd: "/ok" });
    expectLast(200, { node: { id: "node" } });
    expect(mocks.dbClose).toHaveBeenLastCalledWith("/ok/lcm.db");
    mocks.describe.mockRejectedValueOnce(new Error("describe broke"));
    await invoke(handler, { nodeId: "n", cwd: "/ok" });
    expectLast(200, { node: null, error: "describe broke" });
    expect(mocks.dbClose).toHaveBeenLastCalledWith("/ok/lcm.db");
    mocks.describe.mockRejectedValueOnce("failure");
    await invoke(handler, { nodeId: "n", cwd: "/ok" });
    expectLast(200, { node: null, error: "describe failed" });
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
    mocks.exists.mockReturnValueOnce(false);
    await invoke(handler, { nodeId: "n", cwd: "/missing" });
    expectLast(200, { expanded: null, error: "project not found" });
    await invoke(handler, { nodeId: "n", cwd: "/ok", depth: 3 });
    expect(mocks.expand).toHaveBeenLastCalledWith({ summaryIds: ["n"], maxDepth: 3 });
    mocks.expand.mockRejectedValueOnce(new Error("expand broke"));
    await invoke(handler, { nodeId: "n", cwd: "/ok" });
    expectLast(200, { expanded: null, error: "expand broke" });
    expect(mocks.dbClose).toHaveBeenLastCalledWith("/ok/lcm.db");
    mocks.expand.mockRejectedValueOnce("failure");
    await invoke(handler, { nodeId: "n", cwd: "/ok" });
    expectLast(200, { expanded: null, error: "expansion failed" });
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
    mocks.exists.mockReturnValueOnce(false);
    await invoke(handler, { query: "q", cwd: "/missing" });
    expectLast(200, { matches: [] });
    await invoke(handler, { query: "q", cwd: "/ok" });
    expect(mocks.grep).toHaveBeenLastCalledWith({ query: "q", mode: "full_text", scope: "both", since: undefined });
    await invoke(handler, { query: "q", cwd: "/ok", mode: "regex", scope: "messages", since: "2025" });
    expect(mocks.grep).toHaveBeenLastCalledWith({ query: "q", mode: "regex", scope: "messages", since: "2025" });
    mocks.grep.mockRejectedValueOnce(new Error("grep broke"));
    await invoke(handler, { query: "q", cwd: "/ok" });
    expectLast(200, { matches: [] });
  });

  it("covers recent validation, missing projects, defaults, success, and failure", async () => {
    const handler = createRecentHandler(config);
    await invoke(handler, "");
    expectLast(200, { summaries: [] });
    mocks.validate.mockImplementationOnce(() => { throw new Error("bad cwd"); });
    await invoke(handler, { cwd: "/bad" });
    expectLast(200, { summaries: [] });
    mocks.exists.mockReturnValueOnce(false);
    await invoke(handler, { cwd: "/missing" });
    expectLast(200, { summaries: [] });
    mocks.dbAll.mockReturnValueOnce([{ summary_id: "s" }]);
    await invoke(handler, { cwd: "/ok", limit: 2 });
    expectLast(200, { summaries: [{ summary_id: "s" }] });
    expect(mocks.dbAll).toHaveBeenLastCalledWith(2);
    await invoke(handler, { cwd: "/ok" });
    expect(mocks.dbAll).toHaveBeenLastCalledWith(5);
    mocks.dbAll.mockImplementationOnce(() => { throw new Error("query failed"); });
    await invoke(handler, { cwd: "/ok" });
    expectLast(200, { summaries: [] });
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
    const handler = createSearchHandler();
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
    mocks.exists.mockReturnValueOnce(false);
    await invoke(handler, { query: "q", cwd: "/missing" });
    expectLast(200, { episodic: [], promoted: [] });

    mocks.grep.mockResolvedValueOnce({
      messages: [{ id: "match", tags: ["a", "b"] }, { id: "wrong", tags: ["b"] }],
      summaries: [{ id: "untagged", tags: "a" }],
      matches: [],
    });
    mocks.promotedSearch.mockReturnValueOnce([{ id: "promoted" }]);
    await invoke(handler, { query: "q", cwd: "/ok", tags: ["a"], limit: 1 });
    expectLast(200, { episodic: [{ id: "match", tags: ["a", "b"] }], promoted: [{ id: "promoted" }] });
    expect(mocks.promotedSearch).toHaveBeenLastCalledWith("q", 1, ["a"]);

    mocks.grep.mockResolvedValueOnce({ messages: [{ id: "all" }], summaries: [], matches: [] });
    await invoke(handler, { query: "q", cwd: "/ok", tags: [], layers: ["episodic"] });
    expectLast(200, { episodic: [{ id: "all" }], promoted: [] });
    await invoke(handler, { query: "q", cwd: "/ok", tags: "invalid", layers: [] });
    expectLast(200, { episodic: [], promoted: [] });

    mocks.grep.mockRejectedValueOnce(new Error("grep failed"));
    mocks.promotedSearch.mockImplementationOnce(() => { throw new Error("promoted failed"); });
    await invoke(handler, { query: "q", cwd: "/ok" });
    expectLast(200, { episodic: [], promoted: [] });
    mocks.migrate.mockImplementationOnce(() => { throw new Error("migration failed"); });
    await invoke(handler, { query: "q", cwd: "/ok" });
    expectLast(200, { episodic: [], promoted: [] });
  });
});
