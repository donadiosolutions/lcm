import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { backendDiagnosticFailure } from "../../../src/storage/diagnostics.js";
import { StatsUnavailableError } from "../../../src/stats.js";
const mocks = vi.hoisted(() => ({ collect: vi.fn(), validate: vi.fn((cwd: string) => cwd), send: vi.fn() }));
vi.mock("../../../src/stats.js", async importOriginal => ({ ...(await importOriginal<typeof import("../../../src/stats.js")>()), collectStats: mocks.collect }));
vi.mock("../../../src/daemon/server.js", () => ({ sendJson: mocks.send, PKG_VERSION: "test-version" }));
vi.mock("../../../src/daemon/validate-cwd.js", () => ({ validateCwd: mocks.validate }));
import { createStatusHandler } from "../../../src/daemon/routes/status.js";
import { createStatsHandler } from "../../../src/daemon/routes/stats.js";
import { createPoolStatsHandler } from "../../../src/daemon/routes/pool-stats.js";
const config = loadDaemonConfig("/nonexistent");
const diagnostic = backendDiagnosticFailure(new Error("private canary"), "sqlite");
describe("status observation boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validate.mockImplementation(cwd => cwd);
    mocks.collect.mockResolvedValue({ messages: 2, summaries: 3, promotedCount: 4, backendDiagnostics: diagnostic });
  });
  it.each([["stats", createStatsHandler], ["pool", createPoolStatsHandler]])("keeps %s failures typed and omits metrics", async (_name, createHandler) => {
    const res = {} as never;
    for (const failure of [new StatsUnavailableError(diagnostic), new Error("postgres://private-canary")]) {
      mocks.collect.mockRejectedValueOnce(failure);
      await createHandler()({} as never, res, "");
      const body = mocks.send.mock.calls.at(-1)?.[2];
      expect(body).toHaveProperty("backendDiagnostics.classification", "unavailable");
      expect(Object.keys(body)).toEqual(["backendDiagnostics"]);
      expect(JSON.stringify(body)).not.toContain("private-canary");
    }
  });
  it("rejects invalid bodies and cwd using fixed messages", async () => {
    const res = {} as never;
    const handler = createStatusHandler(config, Date.now());
    for (const body of ["bad-json", "null", "[]", '"canary"']) {
      await handler({} as never, res, body);
      expect(mocks.send).toHaveBeenLastCalledWith(res, 400, { error: "invalid request body" });
    }
    await handler({} as never, res, "");
    expect(mocks.send).toHaveBeenLastCalledWith(res, 400, { error: "cwd is required" });
    await handler({} as never, res, '{"cwd":123}');
    expect(mocks.send).toHaveBeenLastCalledWith(res, 400, { error: "invalid cwd" });
    mocks.validate.mockImplementationOnce(() => { throw new Error("secret path canary"); });
    await handler({} as never, res, '{"cwd":"/bad"}');
    expect(mocks.send).toHaveBeenLastCalledWith(res, 400, { error: "invalid cwd" });
    expect(mocks.collect).not.toHaveBeenCalled();
  });
  it("forwards configured home, scope, borrowed factory and cancellation", async () => {
    const controller = new AbortController();
    const factory = {} as never;
    const res = {} as never;
    await createStatusHandler(config, Date.now() - 2500, 4321, "/owned", factory)(
      {} as never, res, '{"cwd":"/project"}', { signal: controller.signal } as never,
    );
    expect(mocks.collect).toHaveBeenCalledExactlyOnceWith({ cwd: "/project", homeDir: "/owned", storageFactory: factory, signal: controller.signal });
    expect(mocks.send).toHaveBeenLastCalledWith(res, 200, {
      daemon: { version: "test-version", uptime: 2, port: 4321 },
      backendDiagnostics: diagnostic,
      project: { messageCount: 2, summaryCount: 3, promotedCount: 4 },
    });
  });
  it("omits unknown metrics and arbitrary metadata after classified failures", async () => {
    const res = {} as never;
    mocks.collect.mockRejectedValueOnce(new StatsUnavailableError(diagnostic));
    await createStatusHandler(config, Date.now())({} as never, res, '{"cwd":"/project"}');
    expect(mocks.send).toHaveBeenLastCalledWith(res, 200, { daemon: { version: "test-version", uptime: 0, port: config.daemon.port }, backendDiagnostics: diagnostic });
    mocks.collect.mockRejectedValueOnce(new Error("postgres://secret@host/private"));
    await createStatusHandler(config, Date.now())({} as never, res, '{"cwd":"/project"}');
    expect(JSON.stringify(mocks.send.mock.calls.at(-1))).not.toContain("postgres://");
    expect(mocks.send.mock.calls.at(-1)?.[2]).not.toHaveProperty("project");
  });
});
