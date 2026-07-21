import { beforeEach, describe, expect, it, vi } from "vitest";

interface McpRequest {
  params: {
    name: string;
    arguments?: unknown;
  };
}

interface McpTextContent {
  type: "text";
  text: string;
}

interface McpHandlerResult {
  content?: McpTextContent[];
  isError?: boolean;
  tools?: unknown[];
}

type McpRequestHandler = (request: McpRequest) => Promise<McpHandlerResult>;

const mocks = vi.hoisted(() => {
  const handlers = new Map<unknown, McpRequestHandler>();
  return {
    handlers,
    connect: vi.fn().mockResolvedValue(undefined),
    ensureDaemon: vi.fn().mockResolvedValue({ connected: true, port: 4321, spawned: false }),
    post: vi.fn().mockResolvedValue({ ok: true }),
    collectStats: vi.fn(),
    runDoctor: vi.fn(),
    formatResultsPlain: vi.fn(),
    storageBackend: "sqlite" as "sqlite" | "postgresql",
  };
});

vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
  CallToolRequestSchema: Symbol("call"),
  ListToolsRequestSchema: Symbol("list"),
}));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: vi.fn().mockImplementation(function () {
    return {
      setRequestHandler: (schema: unknown, handler: McpRequestHandler) => mocks.handlers.set(schema, handler),
      connect: mocks.connect,
    };
  }),
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn().mockImplementation(function () { return {}; }),
}));
vi.mock("../src/daemon/lifecycle.js", () => ({ ensureDaemon: mocks.ensureDaemon }));
vi.mock("../src/daemon/config.js", () => ({
  loadDaemonConfig: () => ({ daemon: { port: 4321 }, storage: { backend: mocks.storageBackend } }),
}));
vi.mock("../src/daemon/client.js", () => ({
  DaemonClient: vi.fn().mockImplementation(function () { return { post: mocks.post }; }),
}));
vi.mock("../src/daemon/version.js", () => ({ PKG_VERSION: "coverage-version" }));
vi.mock("../src/runtime-paths.js", () => ({
  configPath: () => "/tmp/config.json",
  daemonPidPath: () => "/tmp/daemon.pid",
}));
vi.mock("../src/stats.js", () => ({ collectStats: mocks.collectStats, formatNumber: (n: number) => `n${n}` }));
vi.mock("../src/doctor/doctor.js", () => ({ runDoctor: mocks.runDoctor, formatResultsPlain: mocks.formatResultsPlain }));

import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getMcpToolDefinitions, handleDaemonRequest, startMcpServer } from "../src/mcp/server.js";

const SQLITE_STORAGE = { backend: "sqlite" as const };

async function call(name: string, args?: unknown): Promise<Required<Pick<McpHandlerResult, "content">> & McpHandlerResult> {
  const result = await mocks.handlers.get(CallToolRequestSchema)!({ params: { name, arguments: args } });
  if (!result.content) throw new Error(`MCP tool ${name} returned no content`);
  return { ...result, content: result.content };
}

describe("MCP service coverage", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.ensureDaemon.mockResolvedValue({ connected: true, port: 4321, spawned: false });
    mocks.post.mockResolvedValue({ ok: true });
    mocks.storageBackend = "sqlite";
    await startMcpServer();
  });

  it("loads every tool definition module and serves the list handler", async () => {
    const definitions = getMcpToolDefinitions();
    expect(definitions.map((tool) => tool.name)).toEqual([
      "lcm_grep", "lcm_expand", "lcm_describe", "lcm_search", "lcm_store", "lcm_stats", "lcm_doctor",
    ]);
    await expect(mocks.handlers.get(ListToolsRequestSchema)!({ params: { name: "tools/list" } })).resolves.toEqual({ tools: definitions });
    expect(mocks.connect).toHaveBeenCalledOnce();
  });

  it.each([[], "bad"])("rejects non-object tool arguments: %j", async (args) => {
    await expect(call("lcm_search", args)).resolves.toMatchObject({ isError: true });
  });

  it("treats null and missing arguments as an empty object", async () => {
    await expect(call("lcm_search", null)).resolves.toMatchObject({ content: [{ type: "text" }] });
    await expect(call("lcm_search")).resolves.toMatchObject({ content: [{ type: "text" }] });
  });

  it("filters daemon arguments, injects cwd, and rejects unknown tools", async () => {
    const previousPwd = process.env.PWD;
    process.env.PWD = "/coverage/project";
    try {
      await call("lcm_search", { query: "needle", limit: 2, ignored: "secret" });
      expect(mocks.post).toHaveBeenCalledWith("/search", {
        query: "needle", limit: 2, cwd: "/coverage/project",
      });
      await expect(call("not_a_tool", { ignored: true })).resolves.toMatchObject({
        isError: true,
        content: [{ text: "Unknown tool: not_a_tool" }],
      });
    } finally {
      if (previousPwd === undefined) delete process.env.PWD;
      else process.env.PWD = previousPwd;
    }
  });

  it("formats all local stats branches", async () => {
    mocks.collectStats.mockReturnValue({
      projects: 2,
      conversations: 3,
      compactedConversations: 1,
      messages: 2000,
      summaries: 2,
      maxDepth: 4,
      promotedCount: 5,
      eventsCaptured: 7,
      eventsUnprocessed: 1,
      eventsErrors: 2,
      rawTokens: 1000,
      summaryTokens: 100,
      ratio: 10,
      conversationDetails: [
        { conversationId: 1, messages: 2, summaries: 1, maxDepth: 3, rawTokens: 1000, summaryTokens: 100, ratio: 10 },
        { conversationId: 2, messages: 1, summaries: 0, maxDepth: 0, rawTokens: 1, summaryTokens: 0, ratio: 0 },
      ],
      redactionCounts: { total: 6, builtIn: 3, global: 2, project: 1 },
    });
    const result = await call("lcm_stats", { verbose: true, ignored: true });
    expect(result.content[0].text).toContain("## Per Conversation");
    expect(result.content[0].text).toContain("6 total");
    expect(result.content[0].text).not.toContain("ignored");
  });

  it("refuses local stats when the effective backend is unavailable", async () => {
    mocks.storageBackend = "postgresql";

    await expect(call("lcm_stats")).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining("postgresql storage backend is not available") }],
    });
    expect(mocks.collectStats).not.toHaveBeenCalled();
  });

  it("formats zero-token, zero-ratio, empty-detail and zero-redaction stats branches", async () => {
    mocks.collectStats.mockReturnValue({
      projects: 0, conversations: 0, compactedConversations: 0, messages: 0, summaries: 1,
      maxDepth: 0, promotedCount: 0, eventsCaptured: 0, eventsUnprocessed: 0, eventsErrors: 0,
      rawTokens: 0, summaryTokens: 0, ratio: 0, conversationDetails: [],
      redactionCounts: { total: 0, builtIn: 0, global: 0, project: 0 },
    });
    const result = await call("lcm_stats", { verbose: true });
    expect(result.content[0].text).toContain("0.0% compressed");
    expect(result.content[0].text).toContain("| Redactions | 0 |");
    expect(result.content[0].text).not.toContain("## Per Conversation");
  });

  it("omits compression for summary-free stats", async () => {
    mocks.collectStats.mockReturnValue({
      projects: 0, conversations: 0, compactedConversations: 0, messages: 0, summaries: 0,
      maxDepth: 0, promotedCount: 0, eventsCaptured: 0, rawTokens: 0, summaryTokens: 0,
      ratio: 0, conversationDetails: [], redactionCounts: { total: 0, builtIn: 0, global: 0, project: 0 },
    });
    const result = await call("lcm_stats");
    expect(result.content[0].text).not.toContain("## Compression");
  });

  it("omits verbose details when disabled and formats a zero conversation ratio", async () => {
    mocks.collectStats.mockReturnValue({
      projects: 1, conversations: 1, compactedConversations: 1, messages: 1, summaries: 1,
      maxDepth: 1, promotedCount: 0, eventsCaptured: 0, rawTokens: 10, summaryTokens: 5,
      ratio: 2, conversationDetails: [
        { conversationId: 1, messages: 1, summaries: 1, maxDepth: 1, rawTokens: 10, summaryTokens: 5, ratio: 0 },
      ], redactionCounts: { total: 0, builtIn: 0, global: 0, project: 0 },
    });
    expect((await call("lcm_stats", { verbose: false })).content[0].text).not.toContain("## Per Conversation");
    expect((await call("lcm_stats", { verbose: true })).content[0].text).toContain("| – |");
  });

  it("runs doctor locally and converts Error and non-Error failures", async () => {
    mocks.runDoctor.mockResolvedValue([{ name: "ok" }]);
    mocks.formatResultsPlain.mockReturnValue("doctor output");
    await expect(call("lcm_doctor", {})).resolves.toEqual({ content: [{ type: "text", text: "doctor output" }] });

    mocks.runDoctor.mockRejectedValueOnce(new Error("doctor failed"));
    expect((await call("lcm_doctor", {})).content[0].text).toContain("doctor failed");
    mocks.runDoctor.mockRejectedValueOnce("plain failure");
    expect((await call("lcm_doctor", {})).content[0].text).toContain("plain failure");
  });

  it("coalesces concurrent restarts and covers foreground argument variants", async () => {
    let release!: () => void;
    mocks.ensureDaemon.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({}); }));
    const clientA = { post: vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValue({ a: 1 }) };
    const clientB = { post: vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValue({ b: 2 }) };
    const opts = { port: 9876, pidFilePath: "/tmp/pid", storage: SQLITE_STORAGE, spawnArgs: ["daemon", "start"], _ensureDaemon: mocks.ensureDaemon };
    const first = handleDaemonRequest(clientA, "/search", {}, opts);
    const second = handleDaemonRequest(clientB, "/search", {}, opts);
    await vi.waitFor(() => expect(mocks.ensureDaemon).toHaveBeenCalledOnce());
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    const variants = [
      undefined,
      ["daemon", "start", "--foreground"],
      ["other", "command"],
    ];
    for (const [index, spawnArgs] of variants.entries()) {
      const ensure = vi.fn().mockResolvedValue({});
      const client = { post: vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValue({}) };
      await handleDaemonRequest(client, "/search", {}, { port: 20_000 + index, pidFilePath: "/tmp/pid", storage: SQLITE_STORAGE, spawnArgs, _ensureDaemon: ensure });
    }
  });

  it("stringifies non-Error request failures on initial and retry attempts", async () => {
    const direct = { post: vi.fn().mockRejectedValue("direct") };
    expect((await handleDaemonRequest(direct, "/x", {}, { port: 1, pidFilePath: "x", storage: SQLITE_STORAGE })).content[0].text).toContain("direct");

    const retried = { post: vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockRejectedValueOnce("retry") };
    expect((await handleDaemonRequest(retried, "/x", {}, {
      port: 2, pidFilePath: "x", storage: SQLITE_STORAGE, _ensureDaemon: vi.fn().mockResolvedValue({}),
    })).content[0].text).toContain("retry");
  });

  it("formats Error failures, uses default restart, tolerates restart failure, and falls back to cwd", async () => {
    const direct = { post: vi.fn().mockRejectedValue(new Error("direct error")) };
    expect((await handleDaemonRequest(direct, "/x", {}, { port: 11, pidFilePath: "x", storage: SQLITE_STORAGE })).content[0].text)
      .toContain("direct error");

    const retried = { post: vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockRejectedValueOnce(new Error("retry error")) };
    expect((await handleDaemonRequest(retried, "/x", {}, {
      port: 12, pidFilePath: "x", storage: SQLITE_STORAGE, _ensureDaemon: vi.fn().mockRejectedValue(new Error("spawn error")),
    })).content[0].text).toContain("retry error");

    const previousPwd = process.env.PWD;
    delete process.env.PWD;
    mocks.post.mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce({ cwd: true });
    mocks.ensureDaemon.mockRejectedValueOnce(new Error("default spawn error"));
    try {
      await call("lcm_search", { query: "cwd" });
      expect(mocks.post).toHaveBeenLastCalledWith("/search", expect.objectContaining({ cwd: process.cwd() }));
    } finally {
      if (previousPwd !== undefined) process.env.PWD = previousPwd;
    }
  });

  it("default-denies a tool definition without schema properties", async () => {
    vi.resetModules();
    vi.doMock("../src/mcp/tools/lcm-search.js", () => ({
      lcmSearchTool: { name: "lcm_search", description: "search", inputSchema: { type: "object" } },
    }));
    const isolated = await import("../src/mcp/server.js");
    expect(isolated.getMcpToolDefinitions()).toHaveLength(7);
    mocks.post.mockResolvedValueOnce({ accepted: true });
    await isolated.startMcpServer();
    await call("lcm_search", { unexpected: "must-not-cross-boundary" });
    expect(mocks.post).toHaveBeenLastCalledWith("/search", {
      cwd: process.env.PWD ?? process.cwd(),
    });
  });
});
