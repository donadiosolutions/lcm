import * as realHttp from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  listener: undefined as undefined | ((req: unknown, res: unknown) => Promise<void>),
  fail: false,
  listenFailure: undefined as unknown,
  throwProcessorConstructor: false,
  throwWatcher: false,
  health: { status: "healthy", backend: "sqlite" } as Record<string, unknown>,
  closeFactory: vi.fn().mockResolvedValue(undefined),
  closeWatcher: vi.fn(),
  stopProcessor: vi.fn(),
  createFactory: vi.fn(),
  healthFactory: vi.fn(),
}));
const testIdentity = {
  ownerId: "mocked-server-tests",
  entrypoint: "/lcm-tests/mocked-server-daemon.mjs",
} as const;

state.healthFactory.mockImplementation(async () => state.health);
state.createFactory.mockImplementation(async () => ({
  backend: "sqlite",
  capabilities: {},
  projectExists: vi.fn().mockResolvedValue(false),
  openExistingProject: vi.fn().mockResolvedValue(null),
  openProject: vi.fn(),
  health: state.healthFactory,
  close: state.closeFactory,
}));

vi.mock("node:http", async importOriginal => {
  const actual = await importOriginal<typeof realHttp>();
  return {
    ...actual,
    createServer: vi.fn((listener: (req: unknown, res: unknown) => Promise<void>) => {
      state.listener = listener;
      let errorHandler: ((error: Error) => void) | undefined;
      return {
        once: vi.fn((_event: string, handler: (error: Error) => void) => { errorHandler = handler; }),
        off: vi.fn(), address: vi.fn(() => ({ address: "127.0.0.1", family: "IPv4", port: 1234 })),
        close: vi.fn((callback: () => void) => callback()),
        listen: vi.fn((_port: number, _host: string, callback: () => void) => {
          if (state.listenFailure !== undefined) throw state.listenFailure;
          if (state.fail) {
            errorHandler?.(new Error("listen failed"));
            errorHandler?.(new Error("listen failed again"));
          }
          callback();
        }),
      };
    }),
  };
});

vi.mock("../../src/daemon/passive-event-processor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/daemon/passive-event-processor.js")>();
  return {
    ...actual,
    PassiveEventProcessor: class extends actual.PassiveEventProcessor {
      constructor(...args: ConstructorParameters<typeof actual.PassiveEventProcessor>) {
        if (state.throwProcessorConstructor) throw new Error("processor construction failed");
        super(...args);
      }

      override async stopAndWait(): Promise<void> {
        state.stopProcessor();
        await super.stopAndWait();
      }
    },
  };
});

vi.mock("../../src/project-map.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/project-map.js")>();
  return {
    ...actual,
    watchProjectMap: vi.fn(() => {
      if (state.throwWatcher) throw new Error("watcher construction failed");
      return { close: state.closeWatcher };
    }),
  };
});

vi.mock("../../src/storage/index.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/storage/index.js")>();
  return { ...actual, createStorageBackendFactory: state.createFactory };
});

import { ensureAuthToken, readAuthToken } from "../../src/daemon/auth.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createDaemon } from "../../src/daemon/server.js";

afterEach(() => {
  state.fail = false;
  state.listenFailure = undefined;
  state.throwProcessorConstructor = false;
  state.throwWatcher = false;
  state.health = { status: "healthy", backend: "sqlite" };
  state.listener = undefined;
  state.closeFactory.mockClear();
  state.closeWatcher.mockClear();
  state.stopProcessor.mockClear();
  state.createFactory.mockClear();
  state.healthFactory.mockClear();
  vi.restoreAllMocks();
});

describe("mocked server states unavailable from Node HTTP", () => {
  it("waits for an active periodic ingest scan before closing storage", async () => {
    let intervalHandler: (() => Promise<void>) | undefined;
    const realSetInterval = globalThis.setInterval;
    const interval = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 10 * 60 * 1000) {
        intervalHandler = handler as () => Promise<void>;
        return interval;
      }
      return realSetInterval(handler, timeout, ...args);
    }) as typeof setInterval);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    const daemon = await createDaemon(
      loadDaemonConfig("/missing", { daemon: { port: 0, idleTimeoutMs: 0 } }),
      { _scanForTranscripts: () => scanGate },
    );

    const firstScan = intervalHandler?.();
    expect(intervalHandler?.()).toBe(firstScan);
    let stopSettled = false;
    const stopping = daemon.stop().then(() => { stopSettled = true; });
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    expect(state.closeFactory).not.toHaveBeenCalled();
    releaseScan();
    await stopping;
    expect(state.closeFactory).toHaveBeenCalledOnce();
  });

  it("contains synchronous and asynchronous periodic scan failures", async () => {
    let intervalHandler: (() => Promise<void>) | undefined;
    const realSetInterval = globalThis.setInterval;
    const interval = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 10 * 60 * 1000) {
        intervalHandler = handler as () => Promise<void>;
        return interval;
      }
      return realSetInterval(handler, timeout, ...args);
    }) as typeof setInterval);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
    const scan = vi.fn<() => Promise<void>>()
      .mockImplementationOnce(() => { throw new Error("synchronous scan failure"); })
      .mockRejectedValueOnce(new Error("asynchronous scan failure"));
    const daemon = await createDaemon(
      loadDaemonConfig("/missing", { daemon: { port: 0, idleTimeoutMs: 0 } }),
      { _scanForTranscripts: scan },
    );

    await expect(intervalHandler?.()).resolves.toBeUndefined();
    await expect(intervalHandler?.()).resolves.toBeUndefined();
    expect(scan).toHaveBeenCalledTimes(2);
    await daemon.stop();
  });

  it("always reaches storage cleanup when earlier stop steps fail", async () => {
    const daemon = await createDaemon(loadDaemonConfig("/missing", { daemon: { port: 0, idleTimeoutMs: 0 } }));
    vi.spyOn(globalThis, "clearInterval").mockImplementation(() => { throw new Error("interval close failed"); });
    state.closeWatcher.mockImplementationOnce(() => { throw new Error("watcher close failed"); });
    state.stopProcessor.mockImplementationOnce(() => { throw new Error("processor stop failed"); });

    await expect(daemon.stop()).resolves.toBeUndefined();
    expect(state.closeFactory).toHaveBeenCalledOnce();
  });

  it("uses the first value of an authorization header array", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-server-array-auth-"));
    const tokenPath = join(dir, "token"); ensureAuthToken(tokenPath);
    const daemon = await createDaemon(
      loadDaemonConfig("/missing", { daemon: { port: 0, idleTimeoutMs: 0 } }),
      { tokenPath, _testIdentity: testIdentity },
    );
    try {
      let status = 0;
      let body = "";
      daemon.registerRoute("POST", "/custom", async (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      const req = {
        method: "POST", url: "/custom", headers: { authorization: [`Bearer ${readAuthToken(tokenPath)}`, "ignored"] },
        async *[Symbol.asyncIterator]() { yield Buffer.from("{}"); },
      };
      const res = { writeHead: (code: number) => { status = code; }, end: (value: string) => { body = value; } };
      await state.listener?.(req, res);
      expect(status).toBe(200);
      expect(JSON.parse(body)).toEqual({ ok: true });
    } finally {
      await daemon.stop(); rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps public health storage-free and requires valid credentials for full diagnostics", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-server-health-auth-"));
    const tokenPath = join(dir, "token");
    ensureAuthToken(tokenPath);
    const token = readAuthToken(tokenPath)!;
    state.health = { status: "unavailable", backend: "sqlite" };
    const runtimeDigest = "b".repeat(64);
    const daemon = await createDaemon(
      loadDaemonConfig("/missing", { daemon: { port: 0, idleTimeoutMs: 0 } }),
      { tokenPath, _runtimeDigest: runtimeDigest, _testIdentity: testIdentity },
    );
    const request = async (authorization?: string): Promise<{ status: number; body: Record<string, unknown> }> => {
      let status = 0;
      let body = "";
      const req = {
        method: "GET",
        url: "/health",
        headers: authorization === undefined ? {} : { authorization },
      };
      const res = {
        writeHead: (code: number) => { status = code; },
        end: (value: string) => { body = value; },
      };
      await state.listener?.(req, res);
      return { status, body: JSON.parse(body) as Record<string, unknown> };
    };

    try {
      const firstPublic = await request();
      const secondPublic = await request();
      expect(firstPublic.status).toBe(200);
      expect(firstPublic.body).toEqual({
        status: "ok",
        version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
        storageBackend: "sqlite",
        uptime: expect.any(Number),
        pid: process.pid,
        ownerId: testIdentity.ownerId,
      });
      expect(secondPublic.body).toEqual({
        status: "ok",
        version: firstPublic.body.version,
        storageBackend: "sqlite",
        uptime: expect.any(Number),
        pid: process.pid,
        ownerId: testIdentity.ownerId,
      });
      expect(state.healthFactory).not.toHaveBeenCalled();

      expect(await request("Bearer invalid")).toEqual({
        status: 401,
        body: { error: "unauthorized" },
      });
      expect(state.healthFactory).not.toHaveBeenCalled();

      const authenticated = await request(`Bearer ${token}`);
      expect(authenticated.status).toBe(503);
      expect(authenticated.body).toMatchObject({
        status: "unavailable",
        storageBackend: "sqlite",
        entrypoint: expect.any(String),
        runtimeDigest,
        storage: { status: "unavailable" },
      });
      expect(state.healthFactory).toHaveBeenCalledOnce();
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores duplicate startup errors and late listen callbacks without a proxy", async () => {
    state.fail = true;
    await expect(createDaemon(loadDaemonConfig("/missing", { daemon: { port: 0, idleTimeoutMs: 0 } }))).rejects.toThrow("listen failed");
  });

  it("rejects through the cleanup failure fallback", async () => {
    state.fail = true;
    const fakeInterval = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    vi.spyOn(globalThis, "setInterval").mockReturnValue(fakeInterval);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(() => { throw new Error("cleanup failed"); });
    await expect(createDaemon(loadDaemonConfig("/missing", { daemon: { port: 0, idleTimeoutMs: 0 } }))).rejects.toThrow("listen failed");
  });

  it("cleans staged PostgreSQL startup failure without a SQLite ingest interval", async () => {
    state.fail = true;
    const config = loadDaemonConfig("/missing", { daemon: { port: 0, idleTimeoutMs: 0 } });
    config.storage = {
      backend: "postgresql",
      postgresql: {
        url: "postgresql://unused",
        caFile: "/unused",
        poolMax: 1,
        connectionTimeoutMs: 1,
        idleTimeoutMs: 1,
        statementTimeoutMs: 1,
      },
    };

    await expect(createDaemon(config, {
      _createStorageBackendFactory: state.createFactory,
    })).rejects.toThrow("listen failed");
    expect(state.closeFactory).toHaveBeenCalledOnce();
  });

  it("rejects unhealthy storage admission with a cause-free payload", async () => {
    state.health = {
      status: "unavailable",
      backend: "sqlite",
      error: {
        toJSON: () => ({
          name: "StorageOperationError",
          code: "STORAGE_OPERATION_FAILED",
          backend: "sqlite",
          domain: "factory",
          operation: "health",
          retryable: true,
          message: "sqlite factory operation failed",
        }),
      },
    };
    const daemon = await createDaemon(loadDaemonConfig("/missing", { daemon: { port: 0, idleTimeoutMs: 0 } }));
    try {
      let status = 0;
      let body = "";
      const req = { method: "GET", url: "/health", headers: {} };
      const res = {
        writeHead: (code: number) => { status = code; },
        end: (value: string) => { body = value; },
      };

      await state.listener?.(req, res);

      expect(status).toBe(503);
      expect(JSON.parse(body)).toMatchObject({
        status: "unavailable",
        storageBackend: "sqlite",
        storage: {
          status: "unavailable",
          error: { code: "STORAGE_OPERATION_FAILED", operation: "health" },
        },
      });
      expect(body).not.toContain("cause");
    } finally {
      await daemon.stop();
    }
  });

  it("rejects unhealthy storage admission without inventing an error payload", async () => {
    state.health = { status: "degraded", backend: "sqlite" };
    const daemon = await createDaemon(loadDaemonConfig("/missing", { daemon: { port: 0, idleTimeoutMs: 0 } }));
    try {
      let status = 0;
      let body = "";
      const req = { method: "GET", url: "/health", headers: {} };
      const res = {
        writeHead: (code: number) => { status = code; },
        end: (value: string) => { body = value; },
      };

      await state.listener?.(req, res);

      expect(status).toBe(503);
      expect(JSON.parse(body)).toMatchObject({
        status: "unavailable",
        storage: { status: "degraded" },
      });
      expect(JSON.parse(body).storage).not.toHaveProperty("error");
    } finally {
      await daemon.stop();
    }
  });

  it("closes an eager factory when startup construction fails", async () => {
    state.throwWatcher = true;
    await expect(createDaemon(loadDaemonConfig("/missing", { daemon: { port: 0, idleTimeoutMs: 0 } })))
      .rejects.toThrow("watcher construction failed");
    expect(state.closeFactory).toHaveBeenCalledOnce();
    expect(state.stopProcessor).toHaveBeenCalledOnce();
  });

  it("closes the eager factory when processor construction fails before assignment", async () => {
    state.throwProcessorConstructor = true;
    await expect(createDaemon(loadDaemonConfig("/missing", { daemon: { port: 0, idleTimeoutMs: 0 } })))
      .rejects.toThrow("processor construction failed");
    expect(state.stopProcessor).not.toHaveBeenCalled();
    expect(state.closeWatcher).not.toHaveBeenCalled();
    expect(state.closeFactory).toHaveBeenCalledOnce();
  });

  it("cleans constructed resources after a synchronous listen failure", async () => {
    state.listenFailure = new Error("synchronous listen failure");
    await expect(createDaemon(loadDaemonConfig("/missing", { daemon: { port: 0, idleTimeoutMs: 0 } })))
      .rejects.toThrow("synchronous listen failure");
    expect(state.closeWatcher).toHaveBeenCalledOnce();
    expect(state.closeFactory).toHaveBeenCalled();
  });

  it("normalizes a primitive synchronous listen failure", async () => {
    state.listenFailure = "primitive listen failure";
    await expect(createDaemon(loadDaemonConfig("/missing", { daemon: { port: 0, idleTimeoutMs: 0 } })))
      .rejects.toThrow("daemon listen failed");
  });

  it("cleans the interval, watcher, and processor after post-interval construction fails", async () => {
    const failure = new Error("interval handle setup failed");
    const interval = {
      unref: vi.fn(() => { throw failure; }),
    } as unknown as NodeJS.Timeout;
    const clearInterval = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "setInterval").mockReturnValue(interval);

    await expect(createDaemon(loadDaemonConfig("/missing", { daemon: { port: 0, idleTimeoutMs: 0 } })))
      .rejects.toBe(failure);

    expect(clearInterval).toHaveBeenCalledWith(interval);
    expect(state.closeWatcher).toHaveBeenCalledOnce();
    expect(state.stopProcessor).toHaveBeenCalledOnce();
    expect(state.closeFactory).toHaveBeenCalledOnce();
  });

  it.each([
    ["ended", { headersSent: false, writableEnded: true, destroyed: false, writable: true }],
    ["destroyed", { headersSent: false, writableEnded: false, destroyed: true, writable: true }],
    ["not writable", { headersSent: false, writableEnded: false, destroyed: false, writable: false }],
  ])("does not write a buffered fallback to a %s transport", async (_label, transportState) => {
    const daemon = await createDaemon(loadDaemonConfig("/missing", { daemon: { port: 0, idleTimeoutMs: 0 } }));
    daemon.registerRoute("POST", "/custom-buffered-failure", async (_req, res) => {
      res.end("discarded");
      throw new Error("handler failed after ending the buffer");
    }, "mutating");
    const response = {
      ...transportState,
      writeHead: vi.fn(),
      end: vi.fn(),
    };
    const request = {
      method: "POST",
      url: "/custom-buffered-failure",
      headers: {},
      async *[Symbol.asyncIterator]() { yield Buffer.from("{}"); },
    };

    try {
      await state.listener?.(request, response);
      expect(response.writeHead).not.toHaveBeenCalled();
      expect(response.end).not.toHaveBeenCalled();
    } finally {
      await daemon.stop();
    }
  });
});
