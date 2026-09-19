import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createDaemon, type DaemonInstance } from "../../src/daemon/server.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { ensureAuthToken } from "../../src/daemon/auth.js";
import type { BackendDiagnosticSnapshot } from "../../src/storage/diagnostics.js";

const testIdentity = {
  ownerId: "client-tests",
  entrypoint: "/lcm-tests/client-daemon.mjs",
} as const;

describe("DaemonClient", () => {
  let daemon: DaemonInstance | undefined;
  afterEach(async () => { if (daemon) { await daemon.stop(); daemon = undefined; } });

  it("checks health", async () => {
    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }));
    const client = new DaemonClient(`http://127.0.0.1:${daemon.address().port}`);
    expect(await client.health()).toMatchObject({ status: "ok", storageBackend: "sqlite" });
    await expect(client.get<{ backendDiagnostics: BackendDiagnosticSnapshot }>("/stats/pool")).resolves.toMatchObject({
      backendDiagnostics: {
        backend: "sqlite",
        classification: "unavailable",
        pool: { origin: "daemon", status: "ready", total: 0, idle: 0 },
      },
    });
  });

  it("normalizes legacy health responses without a storage backend to sqlite", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok", version: "0.4.0", uptime: 10, pid: 1234 }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected TCP server address");
      const client = new DaemonClient(`http://127.0.0.1:${address.port}`);
      expect(await client.health()).toEqual({
        status: "ok",
        version: "0.4.0",
        storageBackend: "sqlite",
        uptime: 10,
        pid: 1234,
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("recognizes only the structured staged PostgreSQL 503 health response", async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount++;
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        status: "unavailable",
        version: "1.4.1",
        storageBackend: "postgresql",
        uptime: 10,
        pid: 1234,
        storage: {
          status: "unavailable",
          error: {
            code: requestCount === 1
              ? "STORAGE_INITIALIZATION_FAILED"
              : "STORAGE_OPERATION_FAILED",
            backend: "postgresql",
            domain: "factory",
            operation: "health",
          },
        },
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected TCP server address");
      const client = new DaemonClient(`http://127.0.0.1:${address.port}`);
      await expect(client.health()).resolves.toEqual({
        status: "unavailable",
        version: "1.4.1",
        storageBackend: "postgresql",
        uptime: 10,
        pid: 1234,
        storage: {
          status: "unavailable",
          error: {
            code: "STORAGE_INITIALIZATION_FAILED",
            backend: "postgresql",
            domain: "factory",
            operation: "health",
          },
        },
      });
      await expect(client.health()).resolves.toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("returns null when daemon not running", async () => {
    expect(await new DaemonClient("http://127.0.0.1:19999").health()).toBeNull();
  });

  it("rejects non-loopback daemon URLs", () => {
    expect(() => new DaemonClient("http://169.254.169.254:80")).toThrow(/loopback/i);
  });

  it("rejects unknown daemon routes", async () => {
    const client = new DaemonClient("http://127.0.0.1:19999");
    await expect(client.get("http://169.254.169.254/latest")).rejects.toThrow(/route/i);
  });

  it("refuses every protected request before reading credentials when peer admission fails", async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount++;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected TCP server address");
      const readToken = vi.fn(() => "must-not-be-read");
      const verifier = vi.fn(() => { throw new Error("daemon peer is not admitted"); });
      const client = new DaemonClient(
        `http://127.0.0.1:${address.port}`,
        "/unused/token",
        { verifyProtectedRequest: verifier, _readToken: readToken },
      );

      await expect(client.health()).resolves.toBeNull();
      await expect(client.observe()).resolves.toBeNull();
      await expect(client.get("/stats/pool")).rejects.toThrow("daemon peer is not admitted");
      await expect(client.post("/store", { content: "secret body" })).rejects.toThrow("daemon peer is not admitted");
      expect(verifier).toHaveBeenCalledTimes(4);
      expect(readToken).not.toHaveBeenCalled();
      expect(requestCount).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("re-admits the peer before each request while caching only the token", async () => {
    const requests: Array<Readonly<{ authorization?: string; body: string }>> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        requests.push({ authorization: request.headers.authorization, body });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected TCP server address");
      const readToken = vi.fn(() => "stable-token");
      const verifier = vi.fn(async () => undefined);
      const client = new DaemonClient(
        `http://127.0.0.1:${address.port}`,
        "/unused/token",
        { verifyProtectedRequest: verifier, _readToken: readToken },
      );

      await expect(client.get("/stats/pool")).resolves.toEqual({ ok: true });
      await expect(client.post("/store", { secret: "body" })).resolves.toEqual({ ok: true });
      expect(verifier).toHaveBeenCalledTimes(4);
      expect(readToken).toHaveBeenCalledOnce();
      expect(requests).toEqual([
        { authorization: "Bearer stable-token", body: "" },
        { authorization: "Bearer stable-token", body: JSON.stringify({ secret: "body" }) },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("re-admits after the first token read and sends nothing when ownership changed", async () => {
    let requestCount = 0;
    let admitted = true;
    const server = createServer((_request, response) => {
      requestCount++;
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected TCP server address");
      const client = new DaemonClient(
        `http://127.0.0.1:${address.port}`,
        "/unused/token",
        {
          verifyProtectedRequest: () => {
            if (!admitted) throw new Error("daemon peer changed after token read");
          },
          _readToken: () => {
            admitted = false;
            return "must-not-send";
          },
        },
      );
      await expect(client.post("/store", { secret: "body" }))
        .rejects.toThrow("daemon peer changed after token read");
      expect(requestCount).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("uses the auth token for protected GET routes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-client-auth-"));
    const tokenPath = join(dir, "daemon.token");
    ensureAuthToken(tokenPath);

    try {
      daemon = await createDaemon(
        loadDaemonConfig("/x", { daemon: { port: 0 } }),
        { tokenPath, _testIdentity: testIdentity },
      );
      const client = new DaemonClient(`http://127.0.0.1:${daemon.address().port}`, tokenPath);
      await expect(client.health()).resolves.toMatchObject({
        status: "ok",
        storageBackend: "sqlite",
        entrypoint: expect.any(String),
      });
      const baseUrl = `http://127.0.0.1:${daemon.address().port}`;
      const missingTokenClient = new DaemonClient(baseUrl, join(dir, "missing.token"));
      const wrongTokenPath = join(dir, "wrong.token");
      ensureAuthToken(wrongTokenPath);
      const wrongTokenClient = new DaemonClient(baseUrl, wrongTokenPath);
      await expect(missingTokenClient.get("/stats/pool")).rejects.toMatchObject({ statusCode: 401, message: "unauthorized" });
      await expect(wrongTokenClient.get("/stats/pool")).rejects.toMatchObject({ statusCode: 401, message: "unauthorized" });

      const poolStats = await client.get<{ backendDiagnostics: BackendDiagnosticSnapshot }>("/stats/pool");
      // An empty fixture has no project schema, but its observed pool is empty.
      // The successful read also proves credentials reached the protected route.
      expect(Object.keys(poolStats)).toEqual(["backendDiagnostics"]);
      expect(poolStats.backendDiagnostics).toMatchObject({
        backend: "sqlite",
        classification: "unavailable",
        publication: "ready",
        schema: "unverified",
        project: { scope: "aggregate", status: "unavailable" },
      });
      expect(poolStats.backendDiagnostics.pool).toEqual({
        origin: "daemon", status: "ready", total: 0, idle: 0,
      });
      expect(JSON.stringify(poolStats)).not.toContain(dir);
      await expect(client.post("/promote-events/notify", { cwd: dir })).resolves.toEqual({ queued: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits authentication when the configured token file is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-client-no-auth-"));
    const tokenPath = join(dir, "missing.token");

    try {
      daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }));
      const client = new DaemonClient(`http://127.0.0.1:${daemon.address().port}`, tokenPath);
      await expect(client.get<{ backendDiagnostics: BackendDiagnosticSnapshot }>("/stats/pool")).resolves.toMatchObject({
        backendDiagnostics: {
          backend: "sqlite",
          classification: "unavailable",
          pool: { origin: "daemon", status: "ready", total: 0, idle: 0 },
        },
      });
      await expect(client.post("/promote-events/notify", { cwd: dir })).resolves.toEqual({ queued: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
