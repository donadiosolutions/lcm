import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createDaemon, type DaemonInstance } from "../../src/daemon/server.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { ensureAuthToken } from "../../src/daemon/auth.js";

describe("DaemonClient", () => {
  let daemon: DaemonInstance | undefined;
  afterEach(async () => { if (daemon) { await daemon.stop(); daemon = undefined; } });

  it("checks health", async () => {
    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }));
    const client = new DaemonClient(`http://127.0.0.1:${daemon.address().port}`);
    expect(await client.health()).toMatchObject({ status: "ok", storageBackend: "sqlite" });
    await expect(client.get<{ totalConnections: number }>("/stats/pool")).resolves.toMatchObject({
      totalConnections: expect.any(Number),
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

  it("uses the auth token for protected GET routes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-client-auth-"));
    const tokenPath = join(dir, "daemon.token");
    ensureAuthToken(tokenPath);

    try {
      daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }), { tokenPath });
      const client = new DaemonClient(`http://127.0.0.1:${daemon.address().port}`, tokenPath);
      const poolStats = await client.get<{ totalConnections: number }>("/stats/pool");
      expect(poolStats.totalConnections).toBeGreaterThanOrEqual(0);
      await expect(client.get<{ totalConnections: number }>("/stats/pool")).resolves.toMatchObject({
        totalConnections: expect.any(Number),
      });
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
      await expect(client.get<{ totalConnections: number }>("/stats/pool")).resolves.toMatchObject({
        totalConnections: expect.any(Number),
      });
      await expect(client.post("/promote-events/notify", { cwd: dir })).resolves.toEqual({ queued: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
