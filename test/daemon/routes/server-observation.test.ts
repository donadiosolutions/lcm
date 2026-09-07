import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAuthToken, readAuthToken } from "../../../src/daemon/auth.js";
import { loadDaemonConfig, readDaemonConfigSnapshot } from "../../../src/daemon/config.js";
import { createDaemon, type DaemonInstance, type DaemonOptions } from "../../../src/daemon/server.js";
import { createStorageBackendFactory } from "../../../src/storage/factory.js";
import { makeStagedPostgreSqlStorageFactory } from "./mock-storage-factory.js";

const identity = { ownerId: "server-observation-tests", entrypoint: "/lcm-tests/observation-daemon.mjs" };
const generation = "5bd49553-128b-4b3c-a8d7-383e134ebcd3";
const runtimeDigest = "a".repeat(64);

describe("authenticated daemon identity observation", () => {
  let home: string;
  let configPath: string;
  let tokenPath: string;
  let headers: { Authorization: string };
  let daemon: DaemonInstance | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lcm-server-observation-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
    configPath = join(home, ".lcm", "config.json");
    writeFileSync(configPath, "{}\n", { mode: 0o600 });
    tokenPath = join(home, ".lcm", "daemon.token");
    ensureAuthToken(tokenPath);
    headers = { Authorization: `Bearer ${readAuthToken(tokenPath)}` };
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  async function start(options: DaemonOptions = {}) {
    daemon = await createDaemon(loadDaemonConfig(configPath, {
      daemon: { port: 0, idleTimeoutMs: 0 },
    }), {
      tokenPath,
      publicationConfigPath: configPath,
      _testIdentity: identity,
      _daemonInstanceId: generation,
      _runtimeDigest: runtimeDigest,
      ...options,
    });
    return `http://127.0.0.1:${daemon.address().port}`;
  }

  it("returns only process identity without probing health or opening project storage", async () => {
    const factory = await createStorageBackendFactory(loadDaemonConfig(configPath).storage, home);
    const health = vi.spyOn(factory, "health").mockRejectedValue(new Error("active readiness must not run"));
    const open = vi.spyOn(factory, "openProject");
    const openExisting = vi.spyOn(factory, "openExistingProject");
    const exists = vi.spyOn(factory, "projectExists");
    const url = await start({ _createStorageBackendFactory: async () => factory });
    const response = await fetch(`${url}/health/observe`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      observation: "identity-only",
      storage: { status: "unverified" },
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      storageBackend: "sqlite",
      uptime: expect.any(Number),
      pid: process.pid,
      entrypoint: identity.entrypoint,
      ownerId: identity.ownerId,
      daemonInstanceId: generation,
      runtimeDigest,
    });
    expect(health).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(openExisting).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();

    const active = await fetch(`${url}/health`, { headers });
    expect(active.status).toBe(500);
    expect(health).toHaveBeenCalledTimes(1);
  });

  it("omits missing runtime and owner identities instead of inventing them", async () => {
    const previousEntrypoint = process.argv[1];
    process.argv[1] = identity.entrypoint;
    try {
      daemon = await createDaemon(loadDaemonConfig(configPath, { daemon: { port: 0, idleTimeoutMs: 0 } }), {
        tokenPath,
        publicationConfigPath: configPath,
        _runtimeDigest: "",
      });
      const response = await fetch(`http://127.0.0.1:${daemon.address().port}/health/observe`, { headers });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ observation: "identity-only", entrypoint: identity.entrypoint });
      expect(body).not.toHaveProperty("runtimeDigest");
      expect(body).not.toHaveProperty("ownerId");
    } finally {
      process.argv[1] = previousEntrypoint;
    }
  });

  it.each([undefined, "Bearer wrong"])("refuses credentials %s before publication admission or identity exposure", async authorization => {
    const url = await start();
    writeFileSync(configPath, "invalid config", { mode: 0o600 });
    const response = await fetch(`${url}/health/observe`, {
      headers: authorization === undefined ? {} : { Authorization: authorization },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it.each([undefined, "Bearer arbitrary"])("refuses tokenless identity observation with credentials %s", async authorization => {
    const url = await start({ tokenPath: undefined });
    const response = await fetch(`${url}/health/observe`, {
      headers: authorization === undefined ? {} : { Authorization: authorization },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    const active = await fetch(`${url}/health`);
    expect(active.status).toBe(200);
    expect(await active.json()).not.toHaveProperty("observation");
  });

  it("observes staged PostgreSQL identity while active health still reports unavailable", async () => {
    const caPath = join(home, "ca.pem");
    writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n", { mode: 0o600 });
    const config = loadDaemonConfig(join(home, "missing-config.json"), {
      storage: { backend: "postgresql" },
      daemon: { port: 0, idleTimeoutMs: 0 },
    }, {
      LCM_POSTGRES_URL: "postgresql://user:secret@db.example.test/lcm",
      LCM_POSTGRES_CA_FILE: caPath,
      LCM_POSTGRES_MIGRATION_ROLE: "lcm_test_migrator",
    });
    const factory = makeStagedPostgreSqlStorageFactory();
    const health = vi.spyOn(factory, "health");
    daemon = await createDaemon(config, {
      tokenPath,
      _testIdentity: identity,
      _assertBackendPublication: () => undefined,
      _createStorageBackendFactory: async () => factory,
    });
    const url = `http://127.0.0.1:${daemon.address().port}`;
    const observed = await fetch(`${url}/health/observe`, { headers });
    expect(observed.status).toBe(200);
    expect(await observed.json()).toMatchObject({
      observation: "identity-only", storageBackend: "postgresql", storage: { status: "unverified" },
    });
    expect(health).not.toHaveBeenCalled();
    const active = await fetch(`${url}/health`, { headers });
    expect(active.status).toBe(503);
    expect(await active.json()).toMatchObject({
      status: "unavailable", storage: { status: "unavailable", error: { operation: "health" } },
    });
    expect(health).toHaveBeenCalledTimes(1);
  });

  it("refuses a malformed publication journal without returning observed identity", async () => {
    const url = await start();
    const publication = join(home, ".lcm", "backend-publication");
    mkdirSync(publication, { mode: 0o700 });
    writeFileSync(join(publication, "journal.json"), "private-canary", { mode: 0o600 });
    const response = await fetch(`${url}/health/observe`, { headers });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "blocked", error: "backend publication admission blocked" });
  });

  it("discards observed identity when the publication witness changes after the handler", async () => {
    let reads = 0;
    let armed = false;
    const url = await start({ _assertBackendPublication: () => ({
      journalChecksumSha256: armed && ++reads > 1 ? "b".repeat(64) : "a".repeat(64),
    }) });
    armed = true;
    const response = await fetch(`${url}/health/observe`, { headers });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "blocked", error: "backend publication admission blocked" });
  });

  it.each(["before", "after"])("refuses a config witness changed %s observation", async when => {
    let reads = 0;
    const url = await start({ _readDaemonConfigSnapshot: path => {
      if (++reads === 3 && when === "after") writeFileSync(configPath, "{ }\n", { mode: 0o600 });
      return readDaemonConfigSnapshot(path);
    } });
    if (when === "before") writeFileSync(configPath, "invalid config", { mode: 0o600 });
    const response = await fetch(`${url}/health/observe`, { headers });
    expect(response.status).toBe(when === "before" ? 500 : 503);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toHaveProperty("error");
    expect(body).not.toHaveProperty("observation");
    expect(body).not.toHaveProperty("entrypoint");
    expect(body).not.toHaveProperty("runtimeDigest");
    if (when === "after") {
      expect(body).toEqual({ status: "blocked", error: "backend publication admission blocked" });
    }
  });
});
