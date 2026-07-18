import * as realHttp from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  listener: undefined as undefined | ((req: unknown, res: unknown) => Promise<void>),
  fail: false,
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

import { ensureAuthToken, readAuthToken } from "../../src/daemon/auth.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createDaemon } from "../../src/daemon/server.js";

afterEach(() => { state.fail = false; state.listener = undefined; vi.restoreAllMocks(); });

describe("mocked server states unavailable from Node HTTP", () => {
  it("uses the first value of an authorization header array", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-server-array-auth-"));
    const tokenPath = join(dir, "token"); ensureAuthToken(tokenPath);
    const daemon = await createDaemon(loadDaemonConfig("/missing", { daemon: { port: 0, idleTimeoutMs: 0 } }), { tokenPath });
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
});
