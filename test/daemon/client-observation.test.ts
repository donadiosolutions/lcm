import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type RequestListener } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient, parseDaemonObservation } from "../../src/daemon/client.js";
import { ensureAuthToken, readAuthToken } from "../../src/daemon/auth.js";

const observation = {
  status: "ok", observation: "identity-only", storage: { status: "unverified" },
  version: "1.4.2", storageBackend: "sqlite", uptime: 0, pid: 123,
  entrypoint: "/installed/lcm.mjs", daemonInstanceId: "generation", runtimeDigest: "digest",
};

describe("process-only daemon identity observation", () => {
  let server: Server | undefined;
  const homes: string[] = [];
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server!.close(() => resolve()));
      server = undefined;
    }
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it("parses explicit identity without asserting active storage readiness", () => {
    expect(parseDaemonObservation(200, observation)).toEqual(observation);
    expect(parseDaemonObservation(200, { ...observation, storageBackend: "postgresql", ownerId: "owner", runtimeDigest: undefined })).toMatchObject({ storage: { status: "unverified" } });
  });

  it.each([
    [201, observation], [404, observation], [503, { ...observation, status: "unavailable" }],
    [200, null], [200, []], [200, "ok"], [200, { ...observation, status: "healthy" }],
    [200, { ...observation, observation: undefined }], [200, { ...observation, observation: "health" }],
    [200, { ...observation, storage: undefined }], [200, { ...observation, storage: null }],
    [200, { ...observation, storage: { status: "healthy" } }],
    ...["version", "entrypoint", "daemonInstanceId"].flatMap(key => [undefined, "", 1].map(value => [200, { ...observation, [key]: value }])),
    [200, { ...observation, storageBackend: undefined }], [200, { ...observation, storageBackend: "other" }],
    ...[undefined, -1, 1.5, Infinity, "1"].map(uptime => [200, { ...observation, uptime }]),
    ...[undefined, 0, -1, 1.5, Infinity, "1"].map(pid => [200, { ...observation, pid }]),
    [200, { ...observation, runtimeDigest: "" }], [200, { ...observation, runtimeDigest: 1 }],
    [200, { ...observation, ownerId: "" }], [200, { ...observation, ownerId: 1 }],
  ])("refuses malformed or non-observational identity %#", (status, value) => {
    expect(parseDaemonObservation(status as number, value)).toBeNull();
  });

  async function clientFor(handler: RequestListener) {
    const home = mkdtempSync(join(tmpdir(), "lcm-client-observe-"));
    homes.push(home);
    const tokenPath = join(home, "daemon.token");
    ensureAuthToken(tokenPath);
    const token = readAuthToken(tokenPath);
    server = createServer(handler);
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP listener");
    return { client: new DaemonClient(`http://127.0.0.1:${address.port}`, tokenPath), token, address };
  }

  it("sends only authenticated observation and refuses old servers without health retry", async () => {
    const requests: Array<[string | undefined, string | undefined]> = [];
    let status = 200;
    const fixture = await clientFor((request, response) => {
      requests.push([request.url, request.headers.authorization]);
      response.writeHead(status);
      response.end(JSON.stringify(observation));
    });
    expect(await fixture.client.observe()).toEqual(observation);
    status = 404;
    expect(await fixture.client.observe({ timeoutMs: 2000 })).toBeNull();
    expect(requests).toEqual(Array.from({ length: 2 }, () => ["/health/observe", `Bearer ${fixture.token}`]));
    expect(await new DaemonClient(`http://127.0.0.1:${fixture.address.port}`, join(homes[0]!, "missing")).observe()).toBeNull();
    expect(requests).toHaveLength(2);
  });

  it("refuses malformed JSON and expired deadlines without retry", async () => {
    let count = 0;
    const { client } = await clientFor((_request, response) => {
      if (++count === 1) response.end("malformed");
    });
    expect(await client.observe()).toBeNull();
    expect(await client.observe({ timeoutMs: 10 })).toBeNull();
    expect(count).toBe(2);
  });

  it("propagates cancellation and refuses an unavailable daemon", async () => {
    const { client } = await clientFor(() => undefined);
    const controller = new AbortController();
    controller.abort();
    await expect(client.observe({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    server!.closeAllConnections();
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
    expect(await client.observe()).toBeNull();
  });
});
