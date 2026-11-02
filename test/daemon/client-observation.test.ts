import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type RequestListener } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DaemonClient,
  DaemonObservationError,
  describeDaemonObservationFailure,
  parseDaemonObservation,
  type DaemonObservationFailure,
} from "../../src/daemon/client.js";
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

  describe("classified failures", () => {
    it.each([
      [{ reason: "token-missing" }, "the daemon token is missing or empty"],
      [{ reason: "connect-failed" }, "the connection to the daemon failed"],
      [{ reason: "headers-timeout" }, "the daemon did not start responding before the deadline"],
      [{ reason: "body-timeout" }, "the daemon started responding but did not finish before the deadline"],
      [{ reason: "body-invalid" }, "the daemon response body could not be read as JSON"],
      [{ reason: "http-status", statusCode: 503 }, "the daemon answered with HTTP 503"],
      [{ reason: "invalid-identity" }, "the daemon response is not a valid identity observation"],
      [{ reason: "identity-mismatch", fields: ["version", "runtimeDigest"] }, "the daemon identity differs from this installation (version, runtimeDigest)"],
      [{ reason: "local-identity-unavailable" }, "this installation could not determine the identity to expect"],
      [{ reason: "config-changed" }, "the configuration changed during the observation"],
    ] as Array<[DaemonObservationFailure, string]>)("describes %j with a fixed sentence", (failure, sentence) => {
      expect(describeDaemonObservationFailure(failure)).toBe(sentence);
      const error = new DaemonObservationError(failure);
      expect(error).toMatchObject({ name: "DaemonObservationError", message: sentence, failure });
    });

    it("reports a missing token and an unreachable daemon", async () => {
      const fixture = await clientFor(() => undefined);
      expect(await new DaemonClient(`http://127.0.0.1:${fixture.address.port}`, join(homes[0]!, "missing")).observeClassified())
        .toEqual({ kind: "failed", failure: { reason: "token-missing" } });
      server!.closeAllConnections();
      await new Promise<void>(resolve => server!.close(() => resolve()));
      server = undefined;
      expect(await fixture.client.observeClassified()).toEqual({ kind: "failed", failure: { reason: "connect-failed" } });
    });

    it("separates a stall before headers from a stall after headers", async () => {
      let mode: "silent" | "headers" = "silent";
      const { client } = await clientFor((_request, response) => {
        if (mode === "headers") {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.flushHeaders();
        }
      });
      expect(await client.observeClassified({ timeoutMs: 50 })).toEqual({ kind: "failed", failure: { reason: "headers-timeout" } });
      mode = "headers";
      expect(await client.observeClassified({ timeoutMs: 50 })).toEqual({ kind: "failed", failure: { reason: "body-timeout" } });
    });

    it.each([
      ["malformed JSON at 200", 200, "malformed", { kind: "failed", failure: { reason: "body-invalid" } }],
      ["empty body at 200", 200, "", { kind: "failed", failure: { reason: "invalid-identity" } }],
      ["valid JSON that is no identity", 200, "{}", { kind: "failed", failure: { reason: "invalid-identity" } }],
      ["non-JSON 401", 401, "<html>PRIVATE</html>", { kind: "failed", failure: { reason: "http-status", statusCode: 401 } }],
      ["empty 403", 403, "", { kind: "failed", failure: { reason: "http-status", statusCode: 403 } }],
      ["non-JSON 503", 503, "unavailable", { kind: "failed", failure: { reason: "http-status", statusCode: 503 } }],
      ["JSON 404", 404, JSON.stringify(observation), { kind: "failed", failure: { reason: "http-status", statusCode: 404 } }],
    ])("classifies %s", async (_name, status, body, expected) => {
      const { client } = await clientFor((_request, response) => {
        response.writeHead(status);
        response.end(body);
      });
      const result = await client.observeClassified();
      expect(result).toEqual(expected);
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
      expect(await client.observe()).toBeNull();
    });

    it("classifies a response interrupted after its headers as an invalid body", async () => {
      const { client } = await clientFor((request, response) => {
        response.writeHead(200, { "Content-Length": "500" });
        response.write("{");
        setImmediate(() => request.socket.destroy());
      });
      expect(await client.observeClassified({ timeoutMs: 2000 })).toEqual({ kind: "failed", failure: { reason: "body-invalid" } });
    });

    it("rethrows caller cancellation raised while a request is in flight", async () => {
      const { client } = await clientFor(() => undefined);
      const controller = new AbortController();
      const pending = client.observeClassified({ signal: controller.signal });
      setTimeout(() => controller.abort(), 20);
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    });

    const hostile = {
      reason: "identity-mismatch", fields: ["PRIVATE_CANARY"], statusCode: 599,
      body: "PRIVATE_BODY", token: "PRIVATE_TOKEN", kind: "failed", failure: { reason: "PRIVATE_FAILURE" },
    };

    it.each([
      hostile,
      { ...hostile, reason: "future-reason", fields: undefined },
      { reason: "http-status", extra: "PRIVATE_BODY" },
    ])("never lets response properties %j act as failure metadata", async extra => {
      const { client } = await clientFor((_request, response) => {
        response.writeHead(200);
        response.end(JSON.stringify({ ...observation, storage: { status: "unverified", note: "PRIVATE_BODY" }, ...extra }));
      });
      const result = await client.observeClassified();
      expect(result).toStrictEqual({ kind: "observed", observation });
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE/u);
      expect(await client.observe()).toStrictEqual(observation);
    });

    it("copies only the known fields of an accepted observation", () => {
      const nested = { status: "unverified", note: "PRIVATE_BODY" };
      const parsed = parseDaemonObservation(200, { ...observation, ...hostile, storage: nested, ownerId: "owner" });
      expect(parsed).toStrictEqual({ ...observation, ownerId: "owner" });
      expect(parsed!.storage).not.toBe(nested);
    });
  });
});
