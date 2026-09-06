import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";

const mocks = vi.hoisted(() => ({
  sendJson: vi.fn(),
  validateCwd: vi.fn((cwd: string) => cwd),
  withProjectStorage: vi.fn(),
  storageRouteFailureResponse: vi.fn(() => null),
  createRetrievalEngine: vi.fn(),
  grep: vi.fn(),
  searchPromoted: vi.fn(),
}));

vi.mock("../../../src/daemon/server.js", () => ({ sendJson: mocks.sendJson }));
vi.mock("../../../src/daemon/validate-cwd.js", () => ({ validateCwd: mocks.validateCwd }));
vi.mock("../../../src/daemon/routes/storage-lifecycle.js", () => ({
  withProjectStorage: mocks.withProjectStorage,
  storageRouteFailureResponse: mocks.storageRouteFailureResponse,
}));
vi.mock("../../../src/retrieval.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/retrieval.js")>(),
  createRetrievalEngine: mocks.createRetrievalEngine,
}));

import { createSearchHandler } from "../../../src/daemon/routes/search.js";

const config = loadDaemonConfig("/tmp/search-boundaries");
const postgresqlConfig = {
  ...config,
  storage: {
    backend: "postgresql" as const,
    postgresql: {
      url: "postgresql://db.example/lcm",
      poolMax: 5,
      connectionTimeoutMs: 10_000,
      idleTimeoutMs: 30_000,
      statementTimeoutMs: 60_000,
    },
  },
};
const response = {} as never;
const project = { lexicalSearch: { searchPromoted: mocks.searchPromoted } };
const invalidLimits = [0, -0, -1, 1.5, 1001, NaN, Infinity, -Infinity, "5", null, true, {}, []] as const;
const routeConfigs = [["sqlite", config], ["postgresql", postgresqlConfig]] as const;
const invalidLimitCases = routeConfigs.flatMap(([backend, routeConfig]) =>
  invalidLimits.map((limit) => [backend, routeConfig, limit] as const));

function invoke(body: unknown, routeConfig = config) {
  return createSearchHandler(routeConfig)({} as never, response, typeof body === "string" ? body : JSON.stringify(body));
}

describe("search route validation boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateCwd.mockImplementation((cwd: string) => cwd);
    mocks.withProjectStorage.mockImplementation(async (_options, callback) => callback(project));
    mocks.createRetrievalEngine.mockReturnValue({ grep: mocks.grep });
    mocks.grep.mockResolvedValue({ messages: [], summaries: [], totalMatches: 0 });
    mocks.searchPromoted.mockResolvedValue([]);
  });

  it.each(invalidLimitCases)("rejects malformed %j limit %j before cwd and storage admission", async (_backend, routeConfig, limit) => {
    const body = limit === Infinity
      ? '{"query":"q","limit":1e400,"cwd":"/project"}'
      : limit === -Infinity
        ? '{"query":"q","limit":-1e400,"cwd":"/project"}'
      : { query: "q", limit, cwd: "/project" };
    await invoke(body, routeConfig);
    expect(mocks.sendJson).toHaveBeenLastCalledWith(response, 400, { error: "invalid limit" });
    expect(mocks.validateCwd).not.toHaveBeenCalled();
    expect(mocks.withProjectStorage).not.toHaveBeenCalled();
    expect(mocks.createRetrievalEngine).not.toHaveBeenCalled();
    expect(mocks.grep).not.toHaveBeenCalled();
    expect(mocks.searchPromoted).not.toHaveBeenCalled();
  });

  it("accepts exponent notation when finite and integer", async () => {
    await invoke('{"query":"q","limit":1e3,"cwd":"/project"}');
    expect(mocks.sendJson).toHaveBeenLastCalledWith(response, 200, { episodic: [], promoted: [] });
    expect(mocks.searchPromoted).toHaveBeenCalledWith("q", 1000, undefined);
  });

  it("keeps episodic history unfiltered while forwarding tags to promoted search", async () => {
    mocks.grep.mockResolvedValue({
      messages: [
        { messageId: 1, conversationId: 2, role: "user", snippet: "keep-message", createdAt: new Date("2025-01-02") },
        { messageId: 2, conversationId: 2, role: "user", snippet: "drop-message", createdAt: new Date("2025-01-01") },
      ],
      summaries: [{ summaryId: "keep-summary", conversationId: 2, kind: "leaf", snippet: "keep-summary", createdAt: new Date("2024-12-31") }],
      totalMatches: 3,
    });
    mocks.searchPromoted.mockResolvedValue([{ id: "promoted" }]);

    await invoke({ query: "q", limit: 1, cwd: "/project", tags: ["keep"] });

    expect(mocks.validateCwd).toHaveBeenCalledWith("/project");
    expect(mocks.grep).toHaveBeenCalledWith({ query: "q", mode: "full_text", scope: "both", limit: 50 });
    expect(mocks.searchPromoted).toHaveBeenCalledWith("q", 1, ["keep"]);
    expect(mocks.sendJson).toHaveBeenLastCalledWith(response, 200, {
      episodic: [{ messageId: 1, conversationId: 2, role: "user", snippet: "keep-message", createdAt: new Date("2025-01-02") }],
      promoted: [{ id: "promoted" }],
    });
  });

  it.each(routeConfigs)("preserves messages-first episodic ordering at every limit under %s", async (_backend, routeConfig) => {
    const messages = [
      { messageId: 1, conversationId: 2, role: "user", snippet: "older-message-1", createdAt: new Date("2025-01-02") },
      { messageId: 2, conversationId: 2, role: "user", snippet: "older-message-2", createdAt: new Date("2025-01-01") },
    ];
    const summaries = [
      { summaryId: "newer-summary-1", conversationId: 2, kind: "leaf", snippet: "newer-summary-1", createdAt: new Date("2025-01-04") },
      { summaryId: "newer-summary-2", conversationId: 2, kind: "leaf", snippet: "newer-summary-2", createdAt: new Date("2025-01-03") },
    ];
    const expectedByLimit = [
      [messages[0]],
      [messages[0], messages[1]],
      [messages[0], messages[1], summaries[0]],
      [messages[0], messages[1], summaries[0], summaries[1]],
    ];

    for (const [index, expected] of expectedByLimit.entries()) {
      mocks.grep.mockClear();
      mocks.sendJson.mockClear();
      mocks.grep.mockResolvedValue({ messages, summaries, totalMatches: 4 });

      await invoke({ query: "q", limit: index + 1, cwd: "/project" }, routeConfig);

      expect(mocks.sendJson).toHaveBeenLastCalledWith(response, 200, {
        episodic: expected,
        promoted: [],
      });
    }
  });

  it.each(routeConfigs)("forwards the candidate floor under %s", async (_backend, routeConfig) => {
    for (const [requested, expectedGrepLimit, expectedPromotedLimit] of [
      [undefined, 50, 5],
      [1, 50, 1],
      [5, 50, 5],
      [50, 50, 50],
      [51, 51, 51],
      [1000, 1000, 1000],
    ] as const) {
      mocks.grep.mockClear();
      mocks.searchPromoted.mockClear();
      await invoke({ query: "q", cwd: "/project", ...(requested === undefined ? {} : { limit: requested }) }, routeConfig);
      expect(mocks.grep).toHaveBeenLastCalledWith({ query: "q", mode: "full_text", scope: "both", limit: expectedGrepLimit });
      expect(mocks.searchPromoted).toHaveBeenLastCalledWith("q", expectedPromotedLimit, undefined);
    }
  });

  it("uses the default limit for both layers", async () => {
    mocks.grep.mockResolvedValue({
      messages: Array.from({ length: 7 }, (_, index) => ({ id: `message-${index}` })),
      summaries: [],
      totalMatches: 7,
    });
    await invoke({ query: "q", cwd: "/project" });
    expect(mocks.searchPromoted).toHaveBeenCalledWith("q", 5, undefined);
    expect(mocks.grep).toHaveBeenCalledWith({ query: "q", mode: "full_text", scope: "both", limit: 50 });
    expect(mocks.sendJson).toHaveBeenLastCalledWith(response, 200, {
      episodic: Array.from({ length: 5 }, (_, index) => ({ id: `message-${index}` })),
      promoted: [],
    });
  });

  it("caps the maximum limit at 1000 results per layer", async () => {
    mocks.grep.mockResolvedValue({
      messages: Array.from({ length: 1001 }, (_, index) => ({ id: `message-${index}` })),
      summaries: [],
      totalMatches: 1001,
    });
    await invoke({ query: "q", limit: 1000, cwd: "/project", layers: ["episodic"] });
    const result = mocks.sendJson.mock.lastCall?.[2] as { episodic: unknown[]; promoted: unknown[] };
    expect(result.episodic).toHaveLength(1000);
    expect(result.promoted).toEqual([]);
  });

  it("validates limits on the no-cwd path while preserving valid empty responses", async () => {
    await invoke({ query: "q", limit: -1 });
    expect(mocks.sendJson).toHaveBeenLastCalledWith(response, 400, { error: "invalid limit" });
    await invoke({ query: "q", limit: 1000 });
    expect(mocks.sendJson).toHaveBeenLastCalledWith(response, 200, { episodic: [], promoted: [] });
    expect(mocks.withProjectStorage).not.toHaveBeenCalled();
  });

  it("keeps query and limit precedence ahead of later validation", async () => {
    await invoke({ limit: -1, layers: ["invalid"] });
    expect(mocks.sendJson).toHaveBeenLastCalledWith(response, 400, { error: "query is required" });
    await invoke({ query: "q", limit: -1, layers: ["invalid"], cwd: "/bad" });
    expect(mocks.sendJson).toHaveBeenLastCalledWith(response, 400, { error: "invalid limit" });
    expect(mocks.validateCwd).not.toHaveBeenCalled();
  });

  it("rejects an invalid limit even when no layers are selected", async () => {
    await invoke({ query: "q", limit: -1, layers: [], cwd: "/project" });
    expect(mocks.sendJson).toHaveBeenLastCalledWith(response, 400, { error: "invalid limit" });
    expect(mocks.withProjectStorage).not.toHaveBeenCalled();
  });

  it("does not search when the caller explicitly selects no layers", async () => {
    await invoke({ query: "q", limit: 1, layers: [], cwd: "/project" });
    expect(mocks.sendJson).toHaveBeenLastCalledWith(response, 200, { episodic: [], promoted: [] });
    expect(mocks.grep).not.toHaveBeenCalled();
    expect(mocks.searchPromoted).not.toHaveBeenCalled();
  });
});
