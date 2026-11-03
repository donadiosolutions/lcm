import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyRunningDaemon, type VerifyRunningDaemonOptions } from "../../src/daemon/lifecycle.js";
import * as auth from "../../src/daemon/auth.js";

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
    _admitDaemonPeerForTesting: () => ({ pid: process.pid, birth: "birth" }),
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

    await expect(verifyRunningDaemon(options({ _spawnSyncOverride: spawnSyncSpy as never })))
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
    }))).resolves.toEqual({ port, token: TOKEN });
    expect(fetchSpy).toHaveBeenCalled();
  });

  it.each([false, true])("uses default OS admission and refuses a foreign process owner: %s", async foreignOwner => {
    const stateDir = join(dir, ".lcm");
    const procRoot = join(dir, "proc");
    const uid = process.getuid?.() ?? 0;
    mkdirSync(stateDir, { mode: 0o700 });
    mkdirSync(join(procRoot, String(process.pid), "fd"), { recursive: true });
    mkdirSync(join(procRoot, "net"));
    const privatePidPath = join(stateDir, "daemon.pid");
    writeFileSync(privatePidPath, String(process.pid), { mode: 0o600 });
    writeFileSync(join(stateDir, "daemon.token"), TOKEN, { mode: 0o600 });
    writeFileSync(join(procRoot, String(process.pid), "status"), `Uid:\t${foreignOwner ? uid + 1 : uid}\nPPid:\t1\n`);
    writeFileSync(join(procRoot, String(process.pid), "cmdline"), "node\0lcm\0daemon\0start\0");
    symlinkSync("socket:[424242]", join(procRoot, String(process.pid), "fd", "3"));
    writeFileSync(join(procRoot, "net", "tcp"), `sl local_address rem_address st tx_queue tr tm->when retrnsmt uid timeout inode\n0: 0100007F:${port.toString(16)} 00000000:0000 0A 0:0 0:0 0 ${uid} 0 424242 1\n`);
    const readToken = vi.spyOn(auth, "readAuthToken");
    const fetchSpy = vi.fn(globalThis.fetch);

    const result = await verifyRunningDaemon(options({
      pidFilePath: privatePidPath,
      _admitDaemonPeerForTesting: undefined,
      _platform: "linux",
      _procRoot: procRoot,
      _fetchOverride: fetchSpy,
    }));

    if (foreignOwner) {
      expect(result).toBeNull();
      expect(readToken).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } else {
      // Process birth comes from the actual live server process; no admission
      // callback or process-birth replacement supplies this proof.
      expect(result).toEqual({ port, token: TOKEN });
      expect(readToken).toHaveBeenCalledOnce();
      expect(fetchSpy.mock.calls.map(([url]) => new URL(String(url)).pathname))
        .toEqual(["/health", "/health", "/stats/pool"]);
    }
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

  it("refuses unsupported Windows before token access or recipient admission", async () => {
    const readToken = vi.spyOn(auth, "readAuthToken");
    const admitPeer = vi.fn(() => ({ pid: process.pid, birth: "birth" }));
    await expect(verifyRunningDaemon(options({
      _platform: "win32", _admitDaemonPeerForTesting: admitPeer,
    }))).resolves.toBeNull();
    expect(admitPeer).not.toHaveBeenCalled();
    expect(readToken).not.toHaveBeenCalled();
  });

  it("refuses an admitted PID that differs from the private PID file before reading the token", async () => {
    const readToken = vi.spyOn(auth, "readAuthToken");
    await expect(verifyRunningDaemon(options({
      _admitDaemonPeerForTesting: () => ({ pid: process.pid + 1, birth: "foreign-birth" }),
    }))).resolves.toBeNull();
    expect(readToken).not.toHaveBeenCalled();
  });

  it("does not start HTTP when the remaining budget expires after token I/O", async () => {
    const started = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(started);
    vi.spyOn(auth, "readAuthToken").mockImplementation(() => {
      clock.mockReturnValueOnce(started + 49).mockReturnValue(started + 50);
      return TOKEN;
    });
    const fetchSpy = vi.fn(globalThis.fetch);
    await expect(verifyRunningDaemon(options({ budgetMs: 50, _fetchOverride: fetchSpy })))
      .resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["authenticated health", "pool access"] as const)("refuses when the original deadline expires after recipient proof before %s", async phase => {
    const actualNow = performance.now.bind(performance);
    const clock = vi.spyOn(performance, "now").mockImplementation(actualNow);
    let publicHealthSeen = false;
    let authenticatedHealthSeen = false;
    behavior.publicHealth = () => { publicHealthSeen = true; return identity(); };
    behavior.authenticatedHealth = () => {
      authenticatedHealthSeen = true;
      return identity({ entrypoint: ENTRYPOINT, runtimeDigest: DIGEST });
    };
    const targetProof = phase === "authenticated health" ? 3 : 4;
    let proofs = 0;
    const deadlines: number[] = [];
    const fetchSpy = vi.fn(globalThis.fetch);

    await expect(verifyRunningDaemon(options({
      _fetchOverride: fetchSpy,
      _admitDaemonPeerForTesting: (_port, deadline) => {
        deadlines.push(deadline);
        if (++proofs === targetProof) {
          expect(publicHealthSeen).toBe(true);
          expect(authenticatedHealthSeen).toBe(phase === "pool access");
          // The proof itself completes inside the budget; the next HTTP phase
          // observes elapsed time at the caller's unchanged absolute deadline.
          clock.mockReturnValueOnce(deadline - 0.5).mockReturnValue(deadline);
        }
        return { pid: process.pid, birth: "birth" };
      },
    }))).resolves.toBeNull();

    expect(proofs).toBe(targetProof);
    expect(new Set(deadlines).size).toBe(1);
    expect(fetchSpy.mock.calls.map(([url]) => new URL(String(url)).pathname))
      .toEqual(phase === "authenticated health" ? ["/health"] : ["/health", "/health"]);
  });

  it("does not authenticate a peer whose PID changes after public health", async () => {
    let publicHealthSeen = false;
    behavior.publicHealth = () => { publicHealthSeen = true; return identity(); };
    const fetchSpy = vi.fn(globalThis.fetch);
    await expect(verifyRunningDaemon(options({
      _fetchOverride: fetchSpy,
      _admitDaemonPeerForTesting: () => ({
        pid: publicHealthSeen ? process.pid + 1 : process.pid, birth: "birth",
      }),
    }))).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });

  it("refuses process-birth drift between token admission and authenticated health", async () => {
    let publicHealthSeen = false;
    let authenticatedRecipientProved = false;
    behavior.publicHealth = () => { publicHealthSeen = true; return identity(); };
    const fetchSpy = vi.fn(globalThis.fetch);
    await expect(verifyRunningDaemon(options({
      _fetchOverride: fetchSpy,
      _admitDaemonPeerForTesting: () => {
        const birth = authenticatedRecipientProved ? "reused-pid-birth" : "birth";
        if (publicHealthSeen) authenticatedRecipientProved = true;
        return { pid: process.pid, birth };
      },
    }))).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });

  it("refuses process-birth drift after authenticated health before pool access", async () => {
    let authenticatedHealthSeen = false;
    behavior.authenticatedHealth = () => {
      authenticatedHealthSeen = true;
      return identity({ entrypoint: ENTRYPOINT, runtimeDigest: DIGEST });
    };
    const fetchSpy = vi.fn(globalThis.fetch);
    await expect(verifyRunningDaemon(options({
      _fetchOverride: fetchSpy,
      _admitDaemonPeerForTesting: () => ({
        pid: process.pid, birth: authenticatedHealthSeen ? "reused-pid-birth" : "birth",
      }),
    }))).resolves.toBeNull();
    expect(fetchSpy.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/health", "/health"]);
  });

  it("refuses when the authenticated health disagrees with the public identity", async () => {
    behavior.authenticatedHealth = () => identity({ pid: process.pid + 1, entrypoint: ENTRYPOINT, runtimeDigest: DIGEST });
    await expect(verifyRunningDaemon(options())).resolves.toBeNull();
  });

  it("refuses when the token is not accepted", async () => {
    behavior.stats = () => 401;
    await expect(verifyRunningDaemon(options())).resolves.toBeNull();
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

  it("passes the original short budget to each recipient proof without a response-derived fallback", async () => {
    const lsof = vi.fn();
    const deadlines: number[] = [];
    const started = performance.now();
    await expect(verifyRunningDaemon(options({
      budgetMs: 400, _platform: "darwin", _spawnSyncOverride: lsof as never,
      _admitDaemonPeerForTesting: (_port, deadline) => {
        deadlines.push(deadline);
        return { pid: process.pid, birth: "birth" };
      },
    }))).resolves.toEqual({ port, token: TOKEN });
    expect(deadlines.length).toBeGreaterThan(1);
    expect(new Set(deadlines).size).toBe(1);
    expect(deadlines[0]! - started).toBeLessThanOrEqual(401);
    expect(lsof).not.toHaveBeenCalled();
  });
});
