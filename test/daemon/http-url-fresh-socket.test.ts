import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { daemonJsonRequest } from "../../src/daemon/http-url.js";

describe("daemon JSON requests", () => {
  it("opens a fresh closing loopback connection for every request", async () => {
    const seen: IncomingHttpHeaders[] = [];
    let connections = 0;
    const server = createServer((request, response) => {
      seen.push(request.headers);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
    server.on("connection", () => { connections += 1; });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      await daemonJsonRequest(port, "/health", { method: "GET" });
      // Let a keep-alive agent return its socket to the pool before the next request.
      await new Promise<void>(resolve => setImmediate(resolve));
      await daemonJsonRequest(port, "/health", { method: "GET" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }

    // A pooled socket could already be closed by the daemon's keep-alive timer;
    // Connection: close on distinct sockets means no request ever reuses one.
    expect(seen.map(headers => headers.connection)).toEqual(["close", "close"]);
    expect(connections).toBe(2);
  });
});
