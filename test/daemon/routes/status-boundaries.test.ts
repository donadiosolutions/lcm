import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";

const mocks = vi.hoisted(() => ({
  exists: vi.fn(() => false),
  readMetadata: vi.fn(() => "{}"),
  realpath: vi.fn((path: string) => path),
  getConnection: vi.fn(),
  get: vi.fn(() => undefined as { count: number } | undefined),
  close: vi.fn(),
  validate: vi.fn((cwd: string) => cwd),
  send: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: mocks.exists,
  realpathSync: mocks.realpath,
}));
vi.mock("../../../src/security-files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/security-files.js")>()),
  readBoundedRegularFile: mocks.readMetadata,
}));
vi.mock("../../../src/db/connection.js", () => ({
  getLcmConnection: mocks.getConnection,
  closeLcmConnection: mocks.close,
}));
vi.mock("../../../src/daemon/project.js", () => ({
  MAX_PROJECT_METADATA_BYTES: 1024 * 1024,
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
    mocks.readMetadata.mockReturnValue("{}");
    mocks.get.mockReturnValue(undefined);
    mocks.getConnection.mockReturnValue({ prepare: () => ({ get: mocks.get }) });
    mocks.validate.mockImplementation((cwd: string) => cwd);
  });

  it("validates missing and invalid cwd values", async () => {
    const response = {} as never;
    const handler = createStatusHandler(config, Date.now());
    for (const input of [null, [], "invalid"]) {
      await handler({} as never, response, JSON.stringify(input));
      expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "invalid request body" });
    }
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

  it("maps database counts and bounded metadata values and fallbacks", async () => {
    const response = {} as never;
    mocks.exists.mockReturnValue(true);
    mocks.get
      .mockReturnValueOnce({ count: 2 })
      .mockReturnValueOnce({ count: 3 })
      .mockReturnValueOnce({ count: 4 });
    mocks.readMetadata.mockReturnValue(JSON.stringify({ lastIngest: "i", lastCompact: "c", lastPromote: "p" }));
    await createStatusHandler(config, Date.now())({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send.mock.calls.at(-1)?.[2]).toMatchObject({
      project: { messageCount: 2, summaryCount: 3, promotedCount: 4, lastIngest: "i", lastCompact: "c", lastPromote: "p" },
    });
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.readMetadata).toHaveBeenLastCalledWith("/ok/meta.json", {
      allowedRoot: "/ok",
      maxBytes: 1024 * 1024,
      expectedUid: typeof process.getuid === "function" ? process.getuid() : undefined,
      requireSingleLink: true,
    });

    mocks.get.mockReturnValue(undefined);
    mocks.readMetadata.mockReturnValue("{}");
    await createStatusHandler(config, Date.now())({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send.mock.calls.at(-1)?.[2]).toMatchObject({
      project: { messageCount: 0, summaryCount: 0, promotedCount: 0, lastIngest: null, lastCompact: null, lastPromote: null },
    });
  });

  it("keeps HTTP 200 null timestamps for malformed or rejected metadata", async () => {
    const response = {} as never;
    mocks.exists.mockReturnValue(true);
    mocks.get.mockImplementation(() => { throw new Error("query failed"); });
    mocks.readMetadata.mockReturnValue("not-json");
    await createStatusHandler(config, Date.now())({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send.mock.calls.at(-1)?.[2]).toMatchObject({
      project: {
        messageCount: 0,
        summaryCount: 0,
        promotedCount: 0,
        lastIngest: null,
        lastCompact: null,
        lastPromote: null,
      },
    });
    expect(mocks.close).toHaveBeenCalledOnce();

    mocks.readMetadata.mockImplementationOnce(() => { throw new Error("metadata rejected"); });
    await createStatusHandler(config, Date.now())({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, expect.objectContaining({
      project: expect.objectContaining({ lastIngest: null, lastCompact: null, lastPromote: null }),
    }));
  });

  it("omits owner enforcement when the platform has no numeric uid", async () => {
    const response = {} as never;
    const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    try {
      await createStatusHandler(config, Date.now())({} as never, response, JSON.stringify({ cwd: "/ok" }));
      expect(mocks.send).toHaveBeenLastCalledWith(response, 200, expect.objectContaining({
        project: expect.objectContaining({ lastIngest: null, lastCompact: null, lastPromote: null }),
      }));
      expect(mocks.readMetadata).toHaveBeenLastCalledWith("/ok/meta.json", {
        allowedRoot: "/ok",
        maxBytes: 1024 * 1024,
        expectedUid: undefined,
        requireSingleLink: true,
      });
    } finally {
      if (getuidDescriptor === undefined) {
        delete (process as { getuid?: () => number }).getuid;
      } else {
        Object.defineProperty(process, "getuid", getuidDescriptor);
      }
    }
  });

  it("catches malformed bodies and response failures", async () => {
    const response = {} as never;

    await createStatusHandler(config, Date.now())({} as never, response, "{");
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, expect.objectContaining({ error: expect.any(String) }));

    mocks.exists.mockReturnValue(false);
    mocks.send.mockImplementationOnce(() => { throw "response failure"; });
    await createStatusHandler(config, Date.now())({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "status failed" });
  });
});
