import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleSessionEnd } from "../../src/hooks/session-end.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { loadDaemonConfig, type DaemonConfig } from "../../src/daemon/config.js";

vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn().mockResolvedValue({ connected: true, port: 3737, spawned: false }),
}));

vi.mock("../../src/daemon/config.js", () => ({
  loadDaemonConfig: vi.fn(),
}));

const mockHttpReq = vi.hoisted(() => ({
  on: vi.fn().mockReturnThis(),
  write: vi.fn(),
  end: vi.fn(),
}));

vi.mock("node:http", () => ({
  request: vi.fn().mockReturnValue(mockHttpReq),
}));

type IngestResponse = {
  ingested?: number;
  totalTokens?: number;
  redacted?: number;
  redactedCategories?: string[];
};

function createMockClient(ingestResponse: IngestResponse): DaemonClient {
  const client = new DaemonClient("http://127.0.0.1:3737");
  vi.spyOn(client, "post").mockImplementation(async <T>(path: string): Promise<T> => {
    if (path === "/ingest") return ingestResponse as T;
    throw new Error(`unexpected path: ${path}`);
  });
  return client;
}

function createRejectingClient(error: Error): DaemonClient {
  const client = new DaemonClient("http://127.0.0.1:3737");
  vi.spyOn(client, "post").mockRejectedValue(error);
  return client;
}

function httpCallPath(args: readonly unknown[]): unknown {
  const options = args[0];
  return options && typeof options === "object" && "path" in options
    ? options.path
    : undefined;
}

describe("handleSessionEnd", () => {
  let defaultConfig: DaemonConfig;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockHttpReq.on.mockReturnThis();
    const actualConfig = await vi.importActual<typeof import("../../src/daemon/config.js")>(
      "../../src/daemon/config.js",
    );
    defaultConfig = actualConfig.loadDaemonConfig(
      `/definitely-missing-lcm-session-end-${process.pid}.json`,
    );
    vi.mocked(loadDaemonConfig).mockReturnValue(defaultConfig);
  });

  it("calls /ingest with parsed stdin", async () => {
    const client = createMockClient({ ingested: 5, totalTokens: 500 });
    const stdin = JSON.stringify({ session_id: "s1", cwd: "/tmp" });
    const result = await handleSessionEnd(stdin, client, 3737);
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/ingest", { session_id: "s1", cwd: "/tmp", client: "claude" });
  });

  it("returns early when the daemon is unavailable", async () => {
    const { ensureDaemon } = await import("../../src/daemon/lifecycle.js");
    vi.mocked(ensureDaemon).mockResolvedValueOnce({
      connected: false,
      port: 3737,
      spawned: false,
    });
    const client = createMockClient({ ingested: 1 });
    expect(await handleSessionEnd("{}", client)).toEqual({ exitCode: 0, stdout: "" });
    expect(client.post).not.toHaveBeenCalled();
  });

  it("sends auth and exercises the promote-events notification helper", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const { daemonTokenPath } = await import("../../src/runtime-paths.js");
    const { firePromoteEventsNotifyRequest } = await import("../../src/hooks/session-end.js");
    const { request } = await import("node:http");
    const tokenPath = daemonTokenPath();
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, "secret-token\n");
    firePromoteEventsNotifyRequest(4545, { cwd: "/project" });
    expect(vi.mocked(request)).toHaveBeenCalledWith(expect.objectContaining({
      path: "/promote-events/notify",
      headers: expect.objectContaining({ Authorization: "Bearer secret-token" }),
    }));
  });

  it("fires compact via http.request when totalTokens exceeds threshold", async () => {
    const { request } = await import("node:http");
    const client = createMockClient({ ingested: 100, totalTokens: 25000 });
    const stdin = JSON.stringify({ session_id: "s1", cwd: "/tmp" });
    await handleSessionEnd(stdin, client, 3737);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/compact", method: "POST", port: 3737 }),
    );
    expect(mockHttpReq.end).toHaveBeenCalled();
  });

  it("fires compact even when totalTokens is below old threshold", async () => {
    const { request } = await import("node:http");
    const client = createMockClient({ ingested: 5, totalTokens: 500 });
    const stdin = JSON.stringify({ session_id: "s1", cwd: "/tmp" });
    await handleSessionEnd(stdin, client, 3737);
    const httpReqMock = vi.mocked(request);
    const compactCalls = httpReqMock.mock.calls.filter(
      (args) => httpCallPath(args) === "/compact",
    );
    expect(compactCalls.length).toBeGreaterThan(0);
  });

  it("defaults to compact when a legacy config has no hooks section", async () => {
    const configWithoutHooks = { ...defaultConfig };
    Reflect.deleteProperty(configWithoutHooks, "hooks");
    vi.mocked(loadDaemonConfig).mockReturnValueOnce(configWithoutHooks);
    const { request } = await import("node:http");

    await handleSessionEnd(
      JSON.stringify({ session_id: "s1", cwd: "/tmp" }),
      createMockClient({ ingested: 5, totalTokens: 500 }),
      3737,
    );

    expect(vi.mocked(request).mock.calls.some(
      (args) => httpCallPath(args) === "/compact",
    )).toBe(true);
  });

  it("skips compact when hooks.disableAutoCompact is true", async () => {
    const { loadDaemonConfig } = await import("../../src/daemon/config.js");
    vi.mocked(loadDaemonConfig).mockReturnValueOnce({
      ...defaultConfig,
      hooks: { ...defaultConfig.hooks, disableAutoCompact: true },
    });
    const { request } = await import("node:http");
    const client = createMockClient({ ingested: 100, totalTokens: 99999 });
    await handleSessionEnd(JSON.stringify({ session_id: "s1", cwd: "/tmp" }), client, 3737);
    const httpReqMock = vi.mocked(request);
    const compactCalls = httpReqMock.mock.calls.filter(
      (args) => httpCallPath(args) === "/compact",
    );
    expect(compactCalls.length).toBe(0);
  });

  it("fires promote after ingest (always)", async () => {
    const { request } = await import("node:http");
    const client = createMockClient({ ingested: 5, totalTokens: 100 });
    await handleSessionEnd(
      JSON.stringify({ session_id: "s1", cwd: "/tmp" }),
      client, 3737,
    );
    const httpReqMock = vi.mocked(request);
    const promoteCalls = httpReqMock.mock.calls.filter(
      (args) => httpCallPath(args) === "/promote",
    );
    expect(promoteCalls.length).toBe(1);
  });

  it("records session completion in ingest manifest", async () => {
    const { request } = await import("node:http");
    const client = createMockClient({ ingested: 5, totalTokens: 100 });
    await handleSessionEnd(
      JSON.stringify({ session_id: "s1", cwd: "/tmp" }),
      client, 3737,
    );
    const httpReqMock = vi.mocked(request);
    const manifestCalls = httpReqMock.mock.calls.filter(
      (args) => httpCallPath(args) === "/session-complete",
    );
    expect(manifestCalls.length).toBe(1);
  });

  it("does not mark Codex sessions complete because Stop is turn-scoped", async () => {
    const { request } = await import("node:http");
    const client = createMockClient({ ingested: 5, totalTokens: 100 });
    await handleSessionEnd(
      JSON.stringify({ session_id: "s1", cwd: "/tmp", client: "codex" }),
      client,
      3737,
    );
    const httpReqMock = vi.mocked(request);
    const manifestCalls = httpReqMock.mock.calls.filter(
      (args) => httpCallPath(args) === "/session-complete",
    );
    expect(manifestCalls.length).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/ingest", { session_id: "s1", cwd: "/tmp", client: "codex" });
  });

  it("calls socket.unref() so the process does not wait for a compact response", async () => {
    // fireCompactRequest registers a "socket" handler that calls unref() — this is
    // what prevents the Node.js event loop from staying alive until the daemon responds.
    const mockSocket = { unref: vi.fn() };
    mockHttpReq.on.mockImplementation((event: string, cb: (s: unknown) => void) => {
      if (event === "socket") cb(mockSocket);
      if (event === "finish") cb(undefined);
      return mockHttpReq;
    });

    const client = createMockClient({ ingested: 100, totalTokens: 25000 });
    const input = JSON.stringify({ session_id: "s1", cwd: "/tmp" });
    const result = await handleSessionEnd(input, client, 3737);

    expect(result.exitCode).toBe(0);
    expect(mockSocket.unref).toHaveBeenCalled();
  });

  it("fires compact at exact threshold boundary (>=)", async () => {
    const { request } = await import("node:http");
    const client = createMockClient({ ingested: 50, totalTokens: 10000 });
    const input = JSON.stringify({ session_id: "s1", cwd: "/tmp" });
    await handleSessionEnd(input, client, 3737);
    expect(request).toHaveBeenCalled();
  });

  it("handles empty stdin gracefully", async () => {
    const client = createMockClient({ ingested: 0 });
    const result = await handleSessionEnd("", client, 3737);
    expect(result.exitCode).toBe(0);
  });

  it("writes stderr warning when ingest reports redacted content", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { loadDaemonConfig } = await import("../../src/daemon/config.js");
    vi.mocked(loadDaemonConfig).mockReturnValueOnce({
      ...defaultConfig,
      security: { sensitivePatterns: [], notify_on_filter: true },
    });
    const client = createMockClient({
      ingested: 2,
      totalTokens: 500,
      redacted: 1,
      redactedCategories: ["built_in"],
    });
    await handleSessionEnd(JSON.stringify({ session_id: "s1", cwd: "/tmp" }), client, 3737);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("lcm: filtered sensitive data from history (pattern: built_in)"),
    );
    stderrSpy.mockRestore();
  });

  it("does not write stderr when notify_on_filter is false", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { loadDaemonConfig } = await import("../../src/daemon/config.js");
    vi.mocked(loadDaemonConfig).mockReturnValueOnce({
      ...defaultConfig,
      security: { sensitivePatterns: [], notify_on_filter: false },
    });
    const client = createMockClient({
      ingested: 2,
      totalTokens: 500,
      redacted: 1,
      redactedCategories: ["gitleaks"],
    });
    await handleSessionEnd(JSON.stringify({ session_id: "s1", cwd: "/tmp" }), client, 3737);
    const filteredCalls = stderrSpy.mock.calls.filter((args) =>
      typeof args[0] === "string" && args[0].includes("lcm: filtered"),
    );
    expect(filteredCalls.length).toBe(0);
    stderrSpy.mockRestore();
  });

  it("does not write stderr when no redactions occurred", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { loadDaemonConfig } = await import("../../src/daemon/config.js");
    vi.mocked(loadDaemonConfig).mockReturnValueOnce({
      ...defaultConfig,
      security: { sensitivePatterns: [] },
    });
    const client = createMockClient({ ingested: 3, totalTokens: 300 });
    await handleSessionEnd(JSON.stringify({ session_id: "s1", cwd: "/tmp" }), client, 3737);
    const filteredCalls = stderrSpy.mock.calls.filter((args) =>
      typeof args[0] === "string" && args[0].includes("lcm: filtered"),
    );
    expect(filteredCalls.length).toBe(0);
    stderrSpy.mockRestore();
  });

  it.each([
    ["missing", { redacted: 1 }],
    ["empty", { redacted: 1, redactedCategories: [] }],
  ])("uses the unknown category for %s category metadata", async (_label, ingestResponse) => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { request } = await import("node:http");
    await handleSessionEnd(
      JSON.stringify({ session_id: "s1", cwd: "/tmp" }),
      createMockClient(ingestResponse),
    );
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("pattern: unknown)"));
    const complete = vi.mocked(request).mock.calls.find(
      (args) => httpCallPath(args) === "/session-complete",
    );
    expect(complete).toBeDefined();
    stderrSpy.mockRestore();
  });

  it("fails open when ingest rejects or input is malformed", async () => {
    await expect(handleSessionEnd("not json", createMockClient({ ingested: 0 }))).resolves.toEqual({
      exitCode: 0,
      stdout: "",
    });
    await expect(handleSessionEnd("{}", createRejectingClient(new Error("failed"))))
      .resolves.toEqual({ exitCode: 0, stdout: "" });
  });
});

function stdin(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}
