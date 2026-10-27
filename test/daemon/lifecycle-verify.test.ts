import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyRunningDaemon, type VerifyRunningDaemonOptions } from "../../src/daemon/lifecycle.js";

const TOKEN = "verify-token";
const ENTRYPOINT = "/opt/lcm/dist/lcm.mjs";
const DIGEST = "d".repeat(64);

type Behavior = {
  publicHealth: () => Record<string, unknown> | "hang";
  authenticatedHealth: () => Record<string, unknown> | "hang";
  stats: () => number;
};

describe("read-only running daemon verification", () => {
  let dir: string;
  let server: Server;
  let port: number;
  let behavior: Behavior;
  let pidFilePath: string;
  let tokenPath: string;

  const identity = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    status: "ok",
    version: "9.9.9",
    storageBackend: "sqlite",
    pid: process.pid,
    ...extra,
  });
  const options = (extra: Partial<VerifyRunningDaemonOptions> = {}): VerifyRunningDaemonOptions => ({
    port,
    pidFilePath,
    expectedVersion: "9.9.9",
    expectedStorageBackend: "sqlite",
    expectedEntrypoint: ENTRYPOINT,
    expectedRuntimeDigest: DIGEST,
    budgetMs: 2000,
    ...extra,
  });
  const snapshot = (): string => JSON.stringify(readdirSync(dir).sort().map((name) => {
    const stat = statSync(join(dir, name));
    return [name, stat.size, stat.mtimeMs, readFileSync(join(dir, name), "utf-8")];
  }));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "lcm-verify-"));
    pidFilePath = join(dir, "daemon.pid");
    tokenPath = join(dir, "daemon.token");
    writeFileSync(pidFilePath, String(process.pid));
    writeFileSync(tokenPath, TOKEN);
    behavior = {
      publicHealth: () => identity(),
      authenticatedHealth: () => identity({ entrypoint: ENTRYPOINT, runtimeDigest: DIGEST }),
      stats: () => 200,
    };
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const authorized = req.headers.authorization === `Bearer ${TOKEN}`;
      const reply = (body: unknown, status = 200): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/health") {
        const body = req.headers.authorization === undefined ? behavior.publicHealth() : behavior.authenticatedHealth();
        if (body !== "hang") reply(body);
      } else if (req.url === "/stats/pool") {
        reply({}, authorized ? behavior.stats() : 401);
      } else {
        reply({}, 404);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns the verified port and token for the expected authenticated daemon without changing anything", async () => {
    const kill = vi.spyOn(process, "kill");
    const spawnSyncSpy = vi.fn();
    const before = snapshot();

    await expect(verifyRunningDaemon(options({ _spawnSyncOverride: spawnSyncSpy as never,
      _admitDaemonPeerForTesting: () => ({ pid: process.pid, birth: "fixture" }) })))
      .resolves.toEqual({ port, token: TOKEN });

    expect(snapshot()).toBe(before);
    expect(spawnSyncSpy).not.toHaveBeenCalled();
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it("accepts injected platform, process table, fetch, liveness and realpath seams", async () => {
    const fetchSpy = vi.fn(globalThis.fetch);
    await expect(verifyRunningDaemon(options({
      _procRoot: "/proc",
      _fetchOverride: fetchSpy as never,
      _isProcessAliveOverride: () => true,
      _realpathOverride: (path: string) => path,
      _admitDaemonPeerForTesting: () => ({ pid: process.pid, birth: "fixture" }),
    }))).resolves.toEqual({ port, token: TOKEN });
    expect(fetchSpy).toHaveBeenCalled();
  });

  it.each([
    ["a missing expected version", { expectedVersion: undefined }],
    ["an empty expected version", { expectedVersion: "" }],
    ["a missing expected entrypoint", { expectedEntrypoint: undefined }],
    ["a missing expected runtime digest", { expectedRuntimeDigest: undefined }],
    ["a different expected version", { expectedVersion: "1.0.0" }],
    ["a different expected backend", { expectedStorageBackend: "postgresql" as const }],
    ["a different expected entrypoint", { expectedEntrypoint: "/other/lcm.mjs" }],
    ["a different expected runtime digest", { expectedRuntimeDigest: "e".repeat(64) }],
  ])("refuses %s", async (_name, extra) => {
    await expect(verifyRunningDaemon(options(extra))).resolves.toBeNull();
  });

  it("refuses without a PID file, with an unreadable PID, or for a dead process", async () => {
    rmSync(pidFilePath);
    await expect(verifyRunningDaemon(options())).resolves.toBeNull();
    writeFileSync(pidFilePath, "not-a-pid");
    await expect(verifyRunningDaemon(options())).resolves.toBeNull();
    writeFileSync(pidFilePath, String(process.pid));
    await expect(verifyRunningDaemon(options({ _isProcessAliveOverride: () => false }))).resolves.toBeNull();
  });

  it("refuses without a token and never creates one", async () => {
    rmSync(tokenPath);
    await expect(verifyRunningDaemon(options())).resolves.toBeNull();
    expect(readdirSync(dir)).toEqual(["daemon.pid"]);
  });

  it("refuses when the PID-file process is not listening on the configured port", async () => {
    const other = createServer();
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const otherPort = (other.address() as AddressInfo).port;
    await new Promise<void>((resolve) => other.close(() => resolve()));
    await expect(verifyRunningDaemon(options({ port: otherPort }))).resolves.toBeNull();
  });

  it("refuses when the public health reports another process or an unrecognized status", async () => {
    behavior.publicHealth = () => identity({ pid: process.pid + 1 });
    await expect(verifyRunningDaemon(options())).resolves.toBeNull();
    behavior.publicHealth = () => identity({ status: "starting" });
    await expect(verifyRunningDaemon(options())).resolves.toBeNull();
  });

  it("refuses when the authenticated health disagrees with the public identity", async () => {
    behavior.authenticatedHealth = () => identity({ pid: process.pid + 1, entrypoint: ENTRYPOINT, runtimeDigest: DIGEST });
    await expect(verifyRunningDaemon(options())).resolves.toBeNull();
  });

  it("refuses when the token is not accepted", async () => {
    behavior.stats = () => 401;
    await expect(verifyRunningDaemon(options())).resolves.toBeNull();
  });

  it("sends no bearer when local listener admission refuses", async () => {
    const fetch = vi.fn(globalThis.fetch);
    await expect(verifyRunningDaemon(options({
      _fetchOverride: fetch as never,
      _admitDaemonPeerForTesting: () => null,
    }))).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a different reported entrypoint or runtime digest", async () => {
    behavior.authenticatedHealth = () => identity({ entrypoint: "/elsewhere/lcm.mjs", runtimeDigest: DIGEST });
    await expect(verifyRunningDaemon(options())).resolves.toBeNull();
    behavior.authenticatedHealth = () => identity({ entrypoint: ENTRYPOINT, runtimeDigest: "e".repeat(64) });
    await expect(verifyRunningDaemon(options())).resolves.toBeNull();
  });

  it("gives up on a hung public health within the budget", async () => {
    behavior.publicHealth = () => "hang";
    const started = performance.now();
    await expect(verifyRunningDaemon(options({ budgetMs: 150 }))).resolves.toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("gives up on a hung authenticated health within the budget", async () => {
    behavior.authenticatedHealth = () => "hang";
    const started = performance.now();
    await expect(verifyRunningDaemon(options({ budgetMs: 200 }))).resolves.toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("refuses at once when no budget remains or the signal has already fired", async () => {
    await expect(verifyRunningDaemon(options({ budgetMs: 0 }))).resolves.toBeNull();
    const controller = new AbortController();
    controller.abort();
    await expect(verifyRunningDaemon(options({ signal: controller.signal }))).resolves.toBeNull();
  });

  it("only runs a platform listener fallback when its fixed one second timeout fits the budget", async () => {
    const lsof = vi.fn(() => ({ status: 0, stdout: `p${process.pid}\nn127.0.0.1:${port}\n` }));
    const darwin = (extra: Partial<VerifyRunningDaemonOptions>) => options({
      _platform: "darwin",
      _spawnSyncOverride: lsof as never,
      ...extra,
    });

    await expect(verifyRunningDaemon(darwin({ budgetMs: 400 }))).resolves.toBeNull();
    expect(lsof).not.toHaveBeenCalled();

    await expect(verifyRunningDaemon(darwin({ budgetMs: 5000,
      _admitDaemonPeerForTesting: () => ({ pid: process.pid, birth: "fixture" }),
    }))).resolves.toEqual({ port, token: TOKEN });
    expect(lsof).toHaveBeenCalledOnce();
  });
});

