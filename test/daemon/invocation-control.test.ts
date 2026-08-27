import { ensureAuthToken, readAuthToken } from "../../src/daemon/auth.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createDaemon, type DaemonInstance } from "../../src/daemon/server.js";
import {
  createInvocationControlHandler,
  parseInvocationControlBody,
} from "../../src/daemon/routes/invocation-control.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
const invocationId = "22222222-2222-4222-8222-222222222222";
const target = {
  invocation_id: invocationId,
  command: "compact",
  daemon_instance_id: daemonInstanceId,
} as const;
const testIdentity = {
  ownerId: "invocation-control-tests",
  entrypoint: "/lcm-tests/invocation-control-daemon.mjs",
} as const;

describe("authenticated invocation-control route", () => {
  let daemon: DaemonInstance | undefined;
  let home: string | undefined;
  let tokenPath: string | undefined;
  let token: string | undefined;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  afterEach(async () => {
    if (daemon) await daemon.stop();
    daemon = undefined;
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  async function createAuthenticatedDaemon(): Promise<void> {
    home = mkdtempSync(join(tmpdir(), "lcm-invocation-control-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const lcmDir = join(home, ".lcm");
    mkdirSync(lcmDir, { recursive: true, mode: 0o700 });
    const configPath = join(lcmDir, "config.json");
    writeFileSync(configPath, "{}\n", { mode: 0o600 });
    tokenPath = join(home, "daemon.token");
    ensureAuthToken(tokenPath);
    token = readAuthToken(tokenPath)!;
    daemon = await createDaemon(loadDaemonConfig(configPath, { daemon: { port: 0, idleTimeoutMs: 0 } }), {
      tokenPath,
      publicationConfigPath: configPath,
      _daemonInstanceId: daemonInstanceId,
      _testIdentity: testIdentity,
    });
  }

  async function createTokenlessDaemon(): Promise<void> {
    daemon = await createDaemon(loadDaemonConfig("/missing", { daemon: { port: 0, idleTimeoutMs: 0 } }), {
      _daemonInstanceId: daemonInstanceId,
      _testIdentity: testIdentity,
    });
  }

  function control(action: string, body: Record<string, unknown> = target, authorization = token): Promise<Response> {
    return fetch(`http://127.0.0.1:${daemon!.address().port}/invocation-control`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
      },
      body: JSON.stringify({ ...body, action }),
    });
  }

  it("keeps daemon identity out of public health and includes it in authenticated health", async () => {
    await createAuthenticatedDaemon();
    const publicResponse = await fetch(`http://127.0.0.1:${daemon!.address().port}/health`);
    expect(await publicResponse.json()).not.toHaveProperty("daemonInstanceId");
    const authenticated = await fetch(`http://127.0.0.1:${daemon!.address().port}/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await authenticated.json()).toMatchObject({ daemonInstanceId });
  });

  it("requires the daemon bearer token and rejects malformed or cross-instance bodies", async () => {
    await createAuthenticatedDaemon();
    await expect(control("start", target, "wrong-token")).resolves.toMatchObject({ status: 401 });
    const malformed = await control("start", { ...target, unexpected: true });
    expect(malformed.status).toBe(400);
    const wrongInstance = await control("start", {
      ...target,
      daemon_instance_id: "44444444-4444-4444-8444-444444444444",
    });
    expect(wrongInstance.status).toBe(409);
    const duplicate = await fetch(`http://127.0.0.1:${daemon!.address().port}/invocation-control`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: `{"action":"start","invocation_id":"${invocationId}","command":"compact","daemon_instance_id":"${daemonInstanceId}","action":"finish"}`,
    });
    expect(duplicate.status).toBe(400);
  });

  it("keeps invocation control closed when no daemon token is configured", async () => {
    await createTokenlessDaemon();
    const response = await control("start", target, undefined);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("starts, heartbeats, cancels only after targeted work reaches zero, then finishes", async () => {
    await createAuthenticatedDaemon();
    const started = await control("start");
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ state: "active", activeCount: 0, invocationId });
    const heartbeat = await control("heartbeat");
    expect(heartbeat.status).toBe(200);

    const work = daemon!.invocationCoordinator.admitWork({
      invocationId,
      command: "compact",
      daemonInstanceId,
    });
    const cancelResponse = control("cancel");
    let cancelSettled = false;
    void cancelResponse.then(() => { cancelSettled = true; });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("cancel did not reach coordinator")), 2_000);
        if (work.signal.aborted) {
          clearTimeout(timeout);
          resolve();
          return;
        }
        work.signal.addEventListener("abort", () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });
      });
      expect(cancelSettled).toBe(false);
      expect(work.signal.aborted).toBe(true);
    } finally {
      work.release();
    }
    const cancelled = await cancelResponse;
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ state: "cancelling", activeCount: 0 });
    const finished = await control("finish");
    expect(finished.status).toBe(200);
    expect(await finished.json()).toMatchObject({ state: "finished", activeCount: 0 });
    const replay = await control("start");
    expect(replay.status).toBe(409);
  });

  it("returns bounded generic diagnostics for parser edge cases", async () => {
    expect(parseInvocationControlBody(`{ "action":"st\\u0061rt", "invocation_id":"${invocationId}", "command":"compact", "daemon_instance_id":"${daemonInstanceId}" }`))
      .toMatchObject({ action: "start" });
    expect(() => parseInvocationControlBody("[]")).toThrow();
    expect(() => parseInvocationControlBody("not-json")).toThrow();
    expect(() => parseInvocationControlBody(JSON.stringify({ ...target, action: "bogus" }))).toThrow();
    expect(() => parseInvocationControlBody(JSON.stringify({ ...target, command: "promote", action: "start" }))).toThrow();
    expect(() => parseInvocationControlBody(JSON.stringify({ ...target, action: 1 }))).toThrow();
    expect(() => parseInvocationControlBody("{" + "x".repeat(17_000) + "}" )).toThrow(/payload/i);
    expect(() => parseInvocationControlBody("{}" )).toThrow();
    expect(() => parseInvocationControlBody("{\"action\":\"start\"" )).toThrow();
    expect(() => parseInvocationControlBody("{\"action\":\"start\",\"invocation_id\":\"x\",\"command\":\"compact\",\"daemon_instance_id\":\"x\",}" )).toThrow();
    expect(() => parseInvocationControlBody(JSON.stringify({ ...target, action: "start", invocation_id: 1 }))).toThrow();
    await createAuthenticatedDaemon();
    const oversized = await fetch(`http://127.0.0.1:${daemon!.address().port}/invocation-control`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{" + "x".repeat(17_000) + "}",
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "payload too large" });
    const writeHead = vi.fn();
    const end = vi.fn();
    const failingHandler = createInvocationControlHandler({
      start: () => { throw new Error("unexpected"); },
    } as never);
    await failingHandler({} as never, { writeHead, end } as never, JSON.stringify({ action: "start", ...target }));
    expect(writeHead).toHaveBeenCalledWith(400, { "Content-Type": "application/json" });
  });
});
