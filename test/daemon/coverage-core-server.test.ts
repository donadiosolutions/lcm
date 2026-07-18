import { request } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAuthToken, readAuthToken } from "../../src/daemon/auth.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createDaemon, readBody, sendJson, type DaemonInstance } from "../../src/daemon/server.js";
import { clearProjectMapCache } from "../../src/project-map.js";

let home: string;
let daemon: DaemonInstance | undefined;
const originalHome = process.env.HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lcm-core-server-"));
  process.env.HOME = home; clearProjectMapCache();
});
afterEach(async () => {
  if (daemon) await daemon.stop(); daemon = undefined;
  vi.restoreAllMocks(); clearProjectMapCache(); rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
});

const config = (idleTimeoutMs = 0) => loadDaemonConfig("/missing", { daemon: { port: 0, idleTimeoutMs }, llm: { provider: "disabled" } });

describe("server helper boundaries", () => {
  it("reads string and buffer chunks and drains oversized requests", async () => {
    const strings = { async *[Symbol.asyncIterator]() { yield "a"; yield Buffer.from("b"); } };
    await expect(readBody(strings as never)).resolves.toBe("ab");
    const resume = vi.fn();
    const huge = { resume, async *[Symbol.asyncIterator]() { yield "x".repeat(10 * 1024 * 1024 + 1); } };
    await expect(readBody(huge as never)).rejects.toMatchObject({ statusCode: 413 });
    expect(resume).toHaveBeenCalledOnce();
  });

  it.each([null, "text", { error: 3 }, { error: "failure /secret/path", keep: true }])("serializes response shape %#", data => {
    let body = "";
    const res = { writeHead: vi.fn(), end: vi.fn((value: string) => { body = value; }) };
    sendJson(res as never, 202, data);
    expect(res.writeHead).toHaveBeenCalledWith(202, { "Content-Type": "application/json" });
    expect(JSON.parse(body)).toBeDefined();
  });
});

describe("daemon route and lifecycle boundaries", () => {
  it.each([
    { overrides: { _setTimeout: vi.fn() as unknown as typeof setTimeout }, missing: "_clearTimeout" },
    { overrides: { _clearTimeout: vi.fn() as unknown as typeof clearTimeout }, missing: "_setTimeout" },
  ])("rejects an incomplete idle timer override pair missing $missing", async ({ overrides }) => {
    await expect(createDaemon(config(), overrides)).rejects.toThrow(
      "Daemon idle timer overrides must provide both _setTimeout and _clearTimeout",
    );
  });

  it("rejects a missing token file", async () => {
    await expect(createDaemon(config(), { tokenPath: join(home, "missing-token") })).rejects.toThrow("could not be read");
  });

  it("uses the default idle callback", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    let idleCallback: (() => void) | undefined;
    const handle = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const setIdleTimeout = vi.fn((callback: () => void) => { idleCallback = callback; return handle; }) as unknown as typeof setTimeout;
    const clearIdleTimeout = vi.fn() as unknown as typeof clearTimeout;
    daemon = await createDaemon(config(5), { _setTimeout: setIdleTimeout, _clearTimeout: clearIdleTimeout });
    expect(idleCallback).toBeDefined();
    idleCallback!();
    expect(exit).toHaveBeenCalledWith(0);
    expect(daemon.idleTriggered).toBe(true);
  });

  it("covers GET bodies and structured, Error, and non-Error handler failures", async () => {
    daemon = await createDaemon(config());
    daemon.registerRoute("GET", "/custom", async (_req, res, body) => sendJson(res, 200, { body }));
    daemon.registerRoute("POST", "/structured", async () => { throw Object.assign(new Error("bad"), { statusCode: 409 }); });
    daemon.registerRoute("POST", "/plain", async () => { throw "failure"; });
    const base = `http://127.0.0.1:${daemon.address().port}`;
    await expect((await fetch(`${base}/custom?x=1`)).json()).resolves.toEqual({ body: "" });
    expect((await fetch(`${base}/structured`, { method: "POST" })).status).toBe(409);
    const plain = await fetch(`${base}/plain`, { method: "POST" });
    expect(plain.status).toBe(500);
    await expect(plain.json()).resolves.toEqual({ error: "internal error" });
  });

  it("accepts the first authorization value when Node exposes an array", async () => {
    const tokenPath = join(home, "token"); ensureAuthToken(tokenPath);
    const token = readAuthToken(tokenPath)!;
    daemon = await createDaemon(config(), { tokenPath });
    daemon.registerRoute("POST", "/custom", async (_req, res) => sendJson(res, 200, { ok: true }));
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({
        hostname: "127.0.0.1", port: daemon!.address().port, path: "/custom", method: "POST",
        headers: { authorization: [`Bearer ${token}`, "ignored"] },
      }, res => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject); req.end();
    });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true });
  });

  it("tolerates non-Error proxy startup failures and proxy stop failures", async () => {
    const proxy = { start: vi.fn().mockRejectedValue("failed"), stop: vi.fn().mockRejectedValue(new Error("stop")), isHealthy: vi.fn(), port: 1, available: false };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    daemon = await createDaemon(config(), { proxyManager: proxy });
    await daemon.stop(); daemon = undefined;
    expect(proxy.start).toHaveBeenCalled(); expect(proxy.stop).toHaveBeenCalled();
  });
});

describe("periodic transcript scan boundaries", () => {
  it("skips absent, malformed, incomplete, and non-directory project entries", async () => {
    let scan: (() => Promise<void>) | undefined;
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const handle = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 10 * 60 * 1000 && typeof callback === "function") {
        scan = async () => { await callback(...args); };
        return handle;
      }
      return realSetInterval(callback, timeout, ...args);
    }) as typeof setInterval);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(((timer?: NodeJS.Timeout | number | string) => {
      if (timer !== handle) realClearInterval(timer as NodeJS.Timeout);
    }) as typeof clearInterval);

    daemon = await createDaemon(config());
    expect(scan).toBeDefined();
    await scan!(); // projects directory absent

    const projects = join(home, ".lcm", "projects"); mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, "not-a-dir"), "x");
    mkdirSync(join(projects, "no-meta"));
    mkdirSync(join(projects, "bad-meta")); writeFileSync(join(projects, "bad-meta", "meta.json"), "{");
    mkdirSync(join(projects, "no-cwd")); writeFileSync(join(projects, "no-cwd", "meta.json"), "{}");
    mkdirSync(join(projects, "no-sessions")); writeFileSync(join(projects, "no-sessions", "meta.json"), JSON.stringify({ cwd: "/tmp" }));
    await expect(scan!()).resolves.toBeUndefined();
  });
});
