import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";

const mocks = vi.hoisted(() => ({
  exists: vi.fn(() => false),
  read: vi.fn(() => "{}"),
  exec: vi.fn(),
  get: vi.fn(() => undefined as { count: number } | undefined),
  close: vi.fn(),
  validate: vi.fn((cwd: string) => cwd),
  send: vi.fn(),
}));

vi.mock("node:fs", () => ({ existsSync: mocks.exists, readFileSync: mocks.read }));
vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    exec = mocks.exec;
    close = mocks.close;
    prepare() { return { get: mocks.get }; }
  },
}));
vi.mock("../../../src/daemon/project.js", () => ({
  projectDbPath: (cwd: string) => `${cwd}/lcm.db`,
  projectMetaPath: (cwd: string) => `${cwd}/meta.json`,
}));
vi.mock("../../../src/daemon/server.js", () => ({ sendJson: mocks.send, PKG_VERSION: "test-version" }));
vi.mock("../../../src/daemon/validate-cwd.js", () => ({ validateCwd: mocks.validate }));
vi.mock("../../../src/daemon/safe-error.js", () => ({ sanitizeError: (message: string) => message }));

import { createStatusHandler } from "../../../src/daemon/routes/status.js";

const config = loadDaemonConfig("/tmp/status-boundaries");

describe("status persistence boundaries", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.exists.mockReturnValue(false);
    mocks.read.mockReturnValue("{}");
    mocks.get.mockReturnValue(undefined);
    mocks.validate.mockImplementation((cwd: string) => cwd);
  });

  it("validates missing and invalid cwd values", async () => {
    const response = {} as never;
    const handler = createStatusHandler(config, Date.now());
    await handler({} as never, response, "");
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "cwd is required" });
    mocks.validate.mockImplementationOnce(() => { throw new Error("bad cwd"); });
    await handler({} as never, response, JSON.stringify({ cwd: "/bad" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "bad cwd" });
    mocks.validate.mockImplementationOnce(() => { throw "failure"; });
    await handler({} as never, response, JSON.stringify({ cwd: "/bad" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "invalid cwd" });
  });

  it("returns defaults for an absent project using configured and actual ports", async () => {
    const response = {} as never;
    await createStatusHandler(config, Date.now() - 2500)({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, {
      daemon: { version: "test-version", uptime: 2, port: config.daemon.port },
      project: {
        messageCount: 0,
        summaryCount: 0,
        promotedCount: 0,
        lastIngest: null,
        lastCompact: null,
        lastPromote: null,
      },
    });
    await createStatusHandler(config, Date.now(), 4321)({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect((mocks.send.mock.calls.at(-1)?.[2] as { daemon: { port: number } }).daemon.port).toBe(4321);
  });

  it("maps database counts and metadata values and fallbacks", async () => {
    const response = {} as never;
    mocks.exists.mockReturnValue(true);
    mocks.get
      .mockReturnValueOnce({ count: 2 })
      .mockReturnValueOnce({ count: 3 })
      .mockReturnValueOnce({ count: 4 });
    mocks.read.mockReturnValue(JSON.stringify({ lastIngest: "i", lastCompact: "c", lastPromote: "p" }));
    await createStatusHandler(config, Date.now())({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send.mock.calls.at(-1)?.[2]).toMatchObject({
      project: { messageCount: 2, summaryCount: 3, promotedCount: 4, lastIngest: "i", lastCompact: "c", lastPromote: "p" },
    });
    expect(mocks.close).toHaveBeenCalledOnce();

    mocks.get.mockReturnValue(undefined);
    mocks.read.mockReturnValue("{}");
    await createStatusHandler(config, Date.now())({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send.mock.calls.at(-1)?.[2]).toMatchObject({
      project: { messageCount: 0, summaryCount: 0, promotedCount: 0, lastIngest: null, lastCompact: null, lastPromote: null },
    });
  });

  it("recovers from database and metadata failures and catches malformed bodies", async () => {
    const response = {} as never;
    mocks.exists.mockReturnValue(true);
    mocks.get.mockImplementation(() => { throw new Error("query failed"); });
    mocks.read.mockReturnValue("not-json");
    await createStatusHandler(config, Date.now())({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send.mock.calls.at(-1)?.[2]).toMatchObject({
      project: { messageCount: 0, summaryCount: 0, promotedCount: 0, lastIngest: null },
    });
    expect(mocks.close).toHaveBeenCalledOnce();

    await createStatusHandler(config, Date.now())({} as never, response, "{");
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, expect.objectContaining({ error: expect.any(String) }));

    mocks.exists.mockReturnValue(false);
    mocks.send.mockImplementationOnce(() => { throw "response failure"; });
    await createStatusHandler(config, Date.now())({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "status failed" });
  });
});
