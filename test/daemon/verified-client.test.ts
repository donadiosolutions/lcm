import { createServer, request, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:http", async importOriginal => {
  const http = await importOriginal<typeof import("node:http")>();
  return { ...http, request: vi.fn(http.request) };
});

vi.mock("../../src/daemon/peer-admission.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/daemon/peer-admission.js")>(),
  admitCurrentDaemonPeer: vi.fn(() => ({ pid: 42, birth: "birth" })),
}));

import { DaemonClient, DaemonPeerRefusalError, verifiedLocalDaemonClient } from "../../src/daemon/client.js";
import { admitCurrentDaemonPeer } from "../../src/daemon/peer-admission.js";
import * as auth from "../../src/daemon/auth.js";

describe("verified local daemon client", () => {
  let homeDir: string;
  let server: Server;
  let port: number;
  let requests: Array<{ route: string; authorization: string | undefined; body: string }>;

  beforeEach(async () => {
    vi.mocked(request).mockClear();
    vi.mocked(admitCurrentDaemonPeer).mockReset().mockReturnValue({ pid: 42, birth: "birth" });
    homeDir = mkdtempSync(join(tmpdir(), "lcm-verified-client-"));
    mkdirSync(join(homeDir, ".lcm"), { mode: 0o700 });
    writeFileSync(join(homeDir, ".lcm", "daemon.token"), "test-token", { mode: 0o600 });
    requests = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({ route: request.url ?? "", authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8") });
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ status: "ok", pid: 42, version: "1.4.2", storageBackend: "sqlite",
          observation: "identity-only", storage: { status: "unverified" }, uptime: 1, daemonInstanceId: "instance",
          entrypoint: "/opt/lcm.mjs", runtimeDigest: "a".repeat(64) }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("re-admits each cached-token POST and refuses a changed listener before payload", async () => {
    const client = verifiedLocalDaemonClient(port, join(homeDir, ".lcm", "daemon.token"), homeDir);
    await expect(client.post("/search", { query: "first" })).resolves.toMatchObject({ pid: 42 });
    vi.mocked(admitCurrentDaemonPeer).mockReturnValueOnce(null);
    await expect(client.post("/search", { query: "private second", cwd: "/secret" }))
      .rejects.toBeInstanceOf(DaemonPeerRefusalError);
    expect(requests).toEqual([{ route: "/search", authorization: "Bearer test-token", body: '{"query":"first"}' }]);
    expect(admitCurrentDaemonPeer).toHaveBeenCalledTimes(2);
  });

  it("refuses mismatched token and home paths before any request", async () => {
    const client = verifiedLocalDaemonClient(port, join(homeDir, "foreign.token"), homeDir);
    await expect(client.post("/search", { query: "secret" })).rejects.toBeInstanceOf(DaemonPeerRefusalError);
    expect(admitCurrentDaemonPeer).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it("derives its private home from an explicit token path when home is omitted", async () => {
    const client = verifiedLocalDaemonClient(port, join(homeDir, ".lcm", "daemon.token"));
    await expect(client.get("/stats")).resolves.toMatchObject({ pid: 42 });
    expect(admitCurrentDaemonPeer).toHaveBeenCalledWith(expect.objectContaining({ port, homeDir }));
    expect(requests[0]?.authorization).toBe("Bearer test-token");
  });

  it("refuses a positive sub-millisecond remainder after completed admission", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const readToken = vi.spyOn(auth, "readAuthToken");
    const serialize = vi.fn();
    const client = new DaemonClient(`http://127.0.0.1:${port}`, undefined, (_port, deadline) => {
      now = deadline - 0.5;
      return { pid: 42, birth: "birth" };
    });
    await expect(client.post("/store", { toJSON: serialize })).rejects.toBeInstanceOf(DaemonPeerRefusalError);
    expect(readToken).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it("preserves closed peer refusal on health and observation", async () => {
    const client = verifiedLocalDaemonClient(port, undefined, homeDir);
    vi.mocked(admitCurrentDaemonPeer).mockReturnValue(null);
    await expect(client.health()).resolves.toBeNull();
    await expect(client.observeClassified()).resolves.toEqual({ kind: "failed", failure: { reason: "peer-unverified" } });
    expect(requests).toEqual([]);
  });

  it("does not read tokens or serialize bodies when admission is absent or denied", async () => {
    const readToken = vi.spyOn(auth, "readAuthToken");
    const serialize = vi.fn(() => ({ query: "secret" }));
    const client = new DaemonClient(`http://127.0.0.1:${port}`, undefined, () => null);
    await expect(client.post("/store", { toJSON: serialize })).rejects.toBeInstanceOf(DaemonPeerRefusalError);
    await expect(client.get("/stats")).rejects.toBeInstanceOf(DaemonPeerRefusalError);
    expect(readToken).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it("bounds an awaited callback and never sends after its late successful result", async () => {
    let resolve!: (peer: { pid: number; birth: string }) => void;
    const readToken = vi.spyOn(auth, "readAuthToken");
    const serialize = vi.fn();
    const client = new DaemonClient(`http://127.0.0.1:${port}`, undefined,
      () => new Promise(done => { resolve = done; }));
    await expect(client.post("/store", { toJSON: serialize }, { timeoutMs: 15 }))
      .rejects.toBeInstanceOf(DaemonPeerRefusalError);
    resolve({ pid: 42, birth: "birth" });
    await new Promise(done => setImmediate(done));
    expect(readToken).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it("keeps the default admission bounded when no response timeout was requested", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let resolve!: (peer: { pid: number; birth: string }) => void;
      const readToken = vi.spyOn(auth, "readAuthToken");
      const serialize = vi.fn();
      const client = new DaemonClient(`http://127.0.0.1:${port}`, undefined,
        () => new Promise(done => { resolve = done; }));
      const refused = expect(client.post("/store", { toJSON: serialize }))
        .rejects.toBeInstanceOf(DaemonPeerRefusalError);
      await vi.advanceTimersByTimeAsync(2_000);
      await refused;
      resolve({ pid: 42, birth: "birth" });
      await vi.advanceTimersByTimeAsync(0);
      expect(readToken).not.toHaveBeenCalled();
      expect(serialize).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows a response beyond two seconds when the caller omitted a timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let received!: () => void;
      const arrived = new Promise<void>(resolve => { received = resolve; });
      server.removeAllListeners("request");
      server.on("request", (incoming, response) => {
        incoming.resume();
        incoming.on("end", () => {
          setTimeout(() => response.end('{"stored":true}'), 3_000);
          received();
        });
      });
      const client = verifiedLocalDaemonClient(port, undefined, homeDir);
      const result = expect(client.post("/promote-events/all", {})).resolves.toEqual({ stored: true });
      await arrived;
      await vi.advanceTimersByTimeAsync(3_000);
      await result;
      expect(admitCurrentDaemonPeer).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the explicit whole-response deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let received!: (response: ServerResponse) => void;
      const arrived = new Promise<ServerResponse>(resolve => { received = resolve; });
      server.removeAllListeners("request");
      server.on("request", (incoming, response) => {
        incoming.resume();
        incoming.on("end", () => received(response));
      });
      const client = verifiedLocalDaemonClient(port, undefined, homeDir);
      const result = expect(client.post("/store", {}, { timeoutMs: 1_000 })).rejects.toThrow("timed out");
      const response = await arrived;
      await vi.advanceTimersByTimeAsync(1_000);
      await result;
      response.end('{"stored":true}');
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains caller cancellation while an unbudgeted response is pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let received!: (response: ServerResponse) => void;
      const arrived = new Promise<ServerResponse>(resolve => { received = resolve; });
      server.removeAllListeners("request");
      server.on("request", (incoming, response) => {
        incoming.resume();
        incoming.on("end", () => received(response));
      });
      const controller = new AbortController();
      const client = verifiedLocalDaemonClient(port, undefined, homeDir);
      const result = expect(client.post("/store", {}, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      const response = await arrived;
      await vi.advanceTimersByTimeAsync(3_000);
      controller.abort();
      await result;
      response.end('{"stored":true}');
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves health, classified observation and GET for an admitted peer", async () => {
    const client = verifiedLocalDaemonClient(port, undefined, homeDir);
    await expect(client.health()).resolves.toMatchObject({ pid: 42 });
    await expect(client.observeClassified()).resolves.toMatchObject({ kind: "observed", observation: { pid: 42 } });
    await expect(client.get("/stats")).resolves.toMatchObject({ pid: 42 });
    expect(admitCurrentDaemonPeer).toHaveBeenCalledTimes(3);
  });

  it("binds health and observation response PID to the admitted process", async () => {
    vi.mocked(admitCurrentDaemonPeer).mockReturnValue({ pid: 99, birth: "birth" });
    const client = verifiedLocalDaemonClient(port, undefined, homeDir);
    await expect(client.health()).resolves.toBeNull();
    await expect(client.observeClassified()).resolves.toEqual({ kind: "failed", failure: { reason: "invalid-identity" } });
  });

  it.each([undefined, 50])("checks elapsed time after token I/O before serialization (timeout %s)", async timeoutMs => {
    let now = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(auth, "readAuthToken").mockImplementation(() => { now += 2_500; return "token"; });
    const serialize = vi.fn();
    const client = verifiedLocalDaemonClient(port, undefined, homeDir);
    await expect(client.post("/store", { toJSON: serialize }, timeoutMs === undefined ? undefined : { timeoutMs }))
      .rejects.toBeInstanceOf(DaemonPeerRefusalError);
    expect(serialize).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it.each([undefined, 50])("refuses transport when serialization exhausts its original deadline (timeout %s)", async timeoutMs => {
    let now = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const serialize = vi.fn(() => {
      now += 2_500;
      return { query: "private query" };
    });
    const connection = vi.fn();
    server.on("connection", connection);
    const client = verifiedLocalDaemonClient(port, undefined, homeDir);

    await expect(client.post("/store", { toJSON: serialize }, timeoutMs === undefined ? undefined : { timeoutMs }))
      .rejects.toBeInstanceOf(DaemonPeerRefusalError);
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(serialize).toHaveBeenCalledOnce();
    expect(admitCurrentDaemonPeer).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    expect(connection).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });
});
