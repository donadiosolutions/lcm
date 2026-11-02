import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { daemonJsonResponse } from "../../src/daemon/http-url.js";

describe("daemon response failure phases", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  });

  async function listen(handler: RequestListener): Promise<number> {
    server = createServer(handler);
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  async function failure(port: number, timeoutMs?: number): Promise<Error & { daemonPhase?: string; daemonStatusCode?: number }> {
    return await daemonJsonResponse(port, "/health/observe", { method: "GET", timeoutMs }).then(
      () => { throw new Error("expected a failure"); },
      (error: Error) => error,
    );
  }

  it("tags a connection failure before any response", async () => {
    const port = await listen(() => undefined);
    server!.closeAllConnections();
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
    expect(await failure(port)).toMatchObject({ daemonPhase: "request-failed", code: "ECONNREFUSED" });
  });

  it("keeps the inactivity timeout and tags whether headers had arrived", async () => {
    let headers = false;
    const port = await listen((_request, response) => {
      if (headers) {
        response.writeHead(200);
        response.flushHeaders();
      }
    });
    expect(await failure(port, 50)).toMatchObject({
      message: "Daemon request timed out", code: "ETIMEDOUT", daemonPhase: "headers-timeout",
    });
    headers = true;
    expect(await failure(port, 50)).toMatchObject({
      message: "Daemon request timed out", code: "ETIMEDOUT", daemonPhase: "body-timeout",
    });
  });

  it("tags an interrupted response without a status code", async () => {
    const port = await listen((request, response) => {
      response.writeHead(200, { "Content-Length": "500" });
      response.write("{");
      setImmediate(() => request.socket.destroy());
    });
    const error = await failure(port, 2000);
    expect(error).toMatchObject({ message: "Daemon response interrupted", daemonPhase: "body-failed" });
    expect(error.daemonStatusCode).toBeUndefined();
  });

  it.each([200, 401, 503])("tags a body that is not JSON with its HTTP status %i", async status => {
    const port = await listen((_request, response) => {
      response.writeHead(status);
      response.end("not json");
    });
    expect(await failure(port)).toMatchObject({ name: "SyntaxError", daemonPhase: "body-failed", daemonStatusCode: status });
  });
});
