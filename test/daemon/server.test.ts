import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { claudeProjectDirName, createDaemon, projectTranscriptScanCwds, type DaemonInstance } from "../../src/daemon/server.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { ensureAuthToken, readAuthToken } from "../../src/daemon/auth.js";
import { projectDbPath, projectDir } from "../../src/daemon/project.js";
import { recoverMachineIdentity } from "../../src/machine-identity.js";
import { UNBOUND_POSTGRESQL_PROJECT_MESSAGE } from "../../src/storage/identity-context.js";
import {
  clearProjectMapCache,
  hashProjectPath,
  normalizeProjectPath,
  projectMapPath,
  resolveProjectIdentity,
  setRemoteProjectBinding,
} from "../../src/project-map.js";

describe("daemon server", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let tempHome: string | undefined;
  let daemon: DaemonInstance | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-daemon-home-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    clearProjectMapCache();
  });

  afterEach(async () => {
    if (daemon) { await daemon.stop(); daemon = undefined; }
    vi.restoreAllMocks();
    clearProjectMapCache();
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  it("starts and responds to /health", async () => {
    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }));
    const port = daemon.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.storageBackend).toBe("sqlite");
    expect(typeof body.uptime).toBe("number");
  });

  it("health endpoint returns version", async () => {
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const data = await res.json() as { status: string; version: string; storageBackend: string; uptime: number; pid: number };
      expect(data.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(data.status).toBe("ok");
      expect(data.storageBackend).toBe("sqlite");
      expect(data.pid).toBe(process.pid);
    } finally {
      await daemon.stop();
    }
  });

  it("starts with staged PostgreSQL storage and validates route identity before unavailability", async () => {
    const scanForTranscripts = vi.fn(async () => undefined);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const caPath = join(tempHome!, "postgres-ca.pem");
    writeFileSync(
      caPath,
      "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
      { mode: 0o600 },
    );
    const config = loadDaemonConfig(
      "/nonexistent",
      {
        storage: { backend: "postgresql" },
        daemon: { port: 0, idleTimeoutMs: 0 },
        llm: {
          provider: "openai",
          model: "local-test",
          baseURL: "http://127.0.0.1:11435/v1",
        },
      },
      {
        LCM_POSTGRES_URL: "postgresql://user:secret@db.example.test/lcm",
        LCM_POSTGRES_CA_FILE: caPath,
      },
    );
    config.restoration.promptSearchMaxResults = 0;
    daemon = await createDaemon(config, { _scanForTranscripts: scanForTranscripts });
    const port = daemon.address().port;

    expect(setIntervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 10 * 60 * 1000);
    expect(setIntervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 5 * 60 * 1000);
    expect(scanForTranscripts).not.toHaveBeenCalled();

    const healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
    expect(healthResponse.status).toBe(503);
    const health = await healthResponse.json() as {
      status: string;
      storageBackend: string;
      storage: { status: string; error: Record<string, unknown> };
    };
    expect(health).toMatchObject({
      status: "unavailable",
      storageBackend: "postgresql",
      storage: {
        status: "unavailable",
        error: {
          code: "STORAGE_INITIALIZATION_FAILED",
          backend: "postgresql",
          operation: "health",
        },
      },
    });
    expect(JSON.stringify(health)).not.toContain("secret");

    const patternsPath = join(projectDir(tempHome!), "sensitive-patterns.txt");
    mkdirSync(projectDir(tempHome!), { recursive: true });
    writeFileSync(patternsPath, "[", { mode: 0o600 });
    const storeResponse = await fetch(`http://127.0.0.1:${port}/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: tempHome, text: "remember" }),
    });
    rmSync(patternsPath, { force: true });
    expect(storeResponse.status).toBe(409);
    const store = await storeResponse.json() as Record<string, unknown>;
    expect(store).toEqual({
      code: "STORAGE_IDENTITY_REQUIRED",
      storageBackend: "postgresql",
      error: UNBOUND_POSTGRESQL_PROJECT_MESSAGE,
    });
    expect(JSON.stringify(store)).not.toContain(tempHome!);
    expect(JSON.stringify(store)).not.toContain("storage initialization failed");

    const manualReadRequests = [
      { path: "/search", operation: "search", body: { cwd: tempHome, query: "remember" } },
      { path: "/grep", operation: "grep", body: { cwd: tempHome, query: "remember" } },
      { path: "/recent", operation: "recent", body: { cwd: tempHome } },
      { path: "/describe", operation: "describe", body: { cwd: tempHome, nodeId: "node" } },
      { path: "/expand", operation: "expand", body: { cwd: tempHome, nodeId: "node" } },
      {
        path: "/prompt-search",
        operation: "prompt-search",
        body: { cwd: tempHome, query: "remember" },
      },
    ];
    for (const request of manualReadRequests) {
      const response = await fetch(`http://127.0.0.1:${port}${request.path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.body),
      });
      expect(response.status).toBe(409);
      const identityRequired = await response.json() as Record<string, unknown>;
      expect(identityRequired).toEqual({
        code: "STORAGE_IDENTITY_REQUIRED",
        storageBackend: "postgresql",
        error: UNBOUND_POSTGRESQL_PROJECT_MESSAGE,
      });
      expect(JSON.stringify(identityRequired)).not.toContain(tempHome);
      expect(JSON.stringify(identityRequired)).not.toContain("secret");
    }

    const local = resolveProjectIdentity(tempHome!);
    setRemoteProjectBinding("018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020", { hash: local.id });
    for (const request of manualReadRequests) {
      const response = await fetch(`http://127.0.0.1:${port}${request.path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.body),
      });
      expect(response.status).toBe(409);
      const identityRequired = await response.json() as Record<string, unknown>;
      expect(identityRequired).toEqual({
        code: "STORAGE_IDENTITY_REQUIRED",
        error: "machine identity is not registered. "
          + "Run `lcm machine register` before linking a PostgreSQL project.",
        storageBackend: "postgresql",
      });
    }

    recoverMachineIdentity({
      version: 1,
      identityKey: `machine:${"a".repeat(64)}`,
      machineId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9012",
      displayName: "Machine A",
    }, { homeDir: tempHome });
    for (const request of manualReadRequests) {
      const response = await fetch(`http://127.0.0.1:${port}${request.path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.body),
      });
      expect(response.status).toBe(503);
      const unavailable = await response.json();
      expect(unavailable).toEqual({
        code: "STORAGE_BACKEND_STAGED",
        error: `${request.operation} is unavailable while PostgreSQL storage repositories are staged`,
        storageBackend: "postgresql",
      });
      expect(JSON.stringify(unavailable)).not.toContain("secret");
    }

    const stagedProjectRequests = [
      {
        path: "/compact",
        operation: "compact",
        body: { cwd: tempHome, session_id: "s1", skip_ingest: true },
      },
      { path: "/store", operation: "store", body: { cwd: tempHome, text: "remember" } },
      { path: "/promote", operation: "promote", body: { cwd: tempHome } },
      { path: "/restore", operation: "restore", body: { cwd: tempHome, session_id: "s1" } },
      {
        path: "/ingest",
        operation: "ingest",
        body: {
          cwd: tempHome,
          session_id: "s1",
          messages: [{ role: "user", content: "remember", tokenCount: 1 }],
        },
      },
      {
        path: "/session-complete",
        operation: "session-complete",
        body: { cwd: tempHome, session_id: "s1" },
      },
      { path: "/review-stale", operation: "review-stale", body: { cwd: tempHome } },
      {
        path: "/prompt-search",
        operation: "prompt-search",
        body: { cwd: tempHome, query: "remember" },
      },
      { path: "/promote-events", operation: "promote-events", body: { cwd: tempHome } },
      {
        path: "/promote-events/notify",
        operation: "promote-events-notify",
        body: { cwd: tempHome },
      },
    ];
    for (const request of stagedProjectRequests) {
      const response = await fetch(`http://127.0.0.1:${port}${request.path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.body),
      });
      expect(response.status).toBe(503);
      const unavailable = await response.json();
      expect(unavailable).toEqual({
        code: "STORAGE_BACKEND_STAGED",
        error: `${request.operation} is unavailable while PostgreSQL storage repositories are staged`,
        storageBackend: "postgresql",
      });
      expect(JSON.stringify(unavailable)).not.toContain(tempHome);
      expect(JSON.stringify(unavailable)).not.toContain("secret");
    }

    for (const request of [
      { path: "/stats", method: "GET", operation: "stats" },
      { path: "/stats/pool", method: "GET", operation: "pool stats" },
      { path: "/status", method: "POST", operation: "status" },
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${request.path}`, {
        method: request.method,
        ...(request.method === "POST"
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ cwd: tempHome }),
            }
          : {}),
      });
      expect(response.status).toBe(503);
      const unavailable = await response.json() as Record<string, unknown>;
      expect(unavailable).toEqual({
        code: "STORAGE_BACKEND_STAGED",
        error: `${request.operation} is unavailable while PostgreSQL storage repositories are staged`,
        storageBackend: "postgresql",
      });
      expect(JSON.stringify(unavailable)).not.toContain("secret");
    }
  });

  it("returns 404 for unknown routes", async () => {
    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/nope`);
    expect(res.status).toBe(404);
  });

  it("returns 413 when request body exceeds 10 MB", async () => {
    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }));
    const port = daemon.address().port;
    const bigBody = "x".repeat(11 * 1024 * 1024); // 11 MB
    const res = await fetch(`http://127.0.0.1:${port}/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bigBody,
    });
    expect(res.status).toBe(413);
  });

  it("watches map.json and reformats valid user edits", async () => {
    const project = mkdtempSync(join(tmpdir(), "lcm-map-watch-project-"));
    const hash = hashProjectPath(normalizeProjectPath(project));
    mkdirSync(join(homedir(), ".lcm"), { recursive: true });
    const mapPath = projectMapPath();
    writeFileSync(mapPath, JSON.stringify({ [hash]: { canonical: project, aliases: [] } }));

    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0, idleTimeoutMs: 0 } }));

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const tick = () => {
        if (!existsSync(mapPath)) {
          reject(new Error("map.json missing"));
          return;
        }
        const content = readFileSync(mapPath, "utf-8");
        if (content === JSON.stringify({ [hash]: { canonical: project, aliases: [] } }, null, 2) + "\n") {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error(`map.json was not reformatted: ${content}`));
          return;
        }
        setTimeout(tick, 25);
      };
      tick();
    });

    rmSync(project, { recursive: true, force: true });
  });

  it("includes mapped aliases when deriving Claude transcript scan cwds", () => {
    const canonical = mkdtempSync(join(tmpdir(), "lcm-scan-canonical-"));
    const alias = mkdtempSync(join(tmpdir(), "lcm-scan-alias-"));
    const hash = hashProjectPath(normalizeProjectPath(canonical));
    mkdirSync(join(homedir(), ".lcm"), { recursive: true });
    writeFileSync(projectMapPath(), JSON.stringify({
      [hash]: { canonical: normalizeProjectPath(canonical), aliases: [normalizeProjectPath(alias)] },
    }, null, 2) + "\n");
    clearProjectMapCache();

    const cwds = projectTranscriptScanCwds(hash, normalizeProjectPath(canonical));

    expect(cwds).toContain(normalizeProjectPath(canonical));
    expect(cwds).toContain(normalizeProjectPath(alias));
    expect(claudeProjectDirName(normalizeProjectPath(alias))).toBe(normalizeProjectPath(alias).replace(/\//g, "-").replace(/^-/, ""));

    rmSync(canonical, { recursive: true, force: true });
    rmSync(alias, { recursive: true, force: true });
  });

  it("turns Windows paths into relative Claude project directory names", () => {
    expect(claudeProjectDirName("C:\\work\\repo")).toBe("work-repo");
    expect(claudeProjectDirName("\\\\server\\share\\repo")).toBe("server-share-repo");
    expect(claudeProjectDirName("/")).toBe("root");
  });

  it("falls back to meta cwd while map.json is temporarily invalid", () => {
    const canonical = mkdtempSync(join(tmpdir(), "lcm-scan-invalid-map-"));
    mkdirSync(join(homedir(), ".lcm"), { recursive: true });
    writeFileSync(projectMapPath(), "{not-json");
    clearProjectMapCache();

    try {
      expect(projectTranscriptScanCwds("unknown-hash", canonical)).toEqual([canonical]);
    } finally {
      rmSync(canonical, { recursive: true, force: true });
    }
  });

  it("scans alias Claude transcripts into the canonical project database", async () => {
    let scanForTranscripts: (() => void | Promise<void>) | undefined;
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const scanInterval = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 10 * 60 * 1000 && typeof handler === "function") {
        scanForTranscripts = () => handler(...args);
        return scanInterval;
      }
      return realSetInterval(handler, timeout, ...args);
    }) as typeof setInterval);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(((timer?: NodeJS.Timeout | number | string) => {
      if (timer === scanInterval) return;
      realClearInterval(timer as NodeJS.Timeout);
    }) as typeof clearInterval);

    const canonical = mkdtempSync(join(tmpdir(), "lcm-scan-canonical-"));
    const alias = mkdtempSync(join(tmpdir(), "lcm-scan-alias-"));
    const normalizedCanonical = normalizeProjectPath(canonical);
    const normalizedAlias = normalizeProjectPath(alias);
    const hash = hashProjectPath(normalizedCanonical);
    mkdirSync(join(homedir(), ".lcm", "projects", hash), { recursive: true });
    writeFileSync(join(homedir(), ".lcm", "projects", hash, "meta.json"), JSON.stringify({ cwd: normalizedCanonical }, null, 2) + "\n");
    writeFileSync(projectMapPath(), JSON.stringify({
      [hash]: { canonical: normalizedCanonical, aliases: [normalizedAlias] },
    }, null, 2) + "\n");
    clearProjectMapCache();

    const sessionsDir = join(homedir(), ".claude", "projects", claudeProjectDirName(normalizedAlias));
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "ignored.txt"), "not a transcript");
    writeFileSync(join(sessionsDir, "alias-session.jsonl"), [
      JSON.stringify({ message: { role: "user", content: [{ type: "text", text: "Alias scan question" }] } }),
      JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "Alias scan answer" }] } }),
    ].join("\n") + "\n");

    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0, idleTimeoutMs: 0 } }));
    expect(scanForTranscripts).toBeDefined();

    await scanForTranscripts?.();

    const db = new DatabaseSync(projectDbPath(normalizedCanonical));
    try {
      const row = db.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number };
      expect(row.count).toBe(2);
    } finally {
      db.close();
      rmSync(canonical, { recursive: true, force: true });
      rmSync(alias, { recursive: true, force: true });
    }
  });
});

describe("daemon idle timeout", () => {
  it("rejects out-of-range idle timeout values", async () => {
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.daemon.idleTimeoutMs = Number.MAX_SAFE_INTEGER;
    await expect(createDaemon(config)).rejects.toThrow(/idle timeout/i);
  });

  it("calls onIdle after idle timeout", async () => {
    let idleCalled = false;
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.daemon.idleTimeoutMs = 200;
    const daemon = await createDaemon(config, { onIdle: () => { idleCalled = true; } });

    // Wait for idle timeout
    await new Promise(r => setTimeout(r, 400));

    expect(idleCalled).toBe(true);
    expect(daemon.idleTriggered).toBe(true);
    await daemon.stop();
  });

  it("resets idle timer on request", async () => {
    let idleCalled = false;
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.daemon.idleTimeoutMs = 300;
    const daemon = await createDaemon(config, { onIdle: () => { idleCalled = true; } });
    const port = daemon.address().port;

    // Make requests to keep alive
    await fetch(`http://127.0.0.1:${port}/health`);
    await new Promise(r => setTimeout(r, 200));
    await fetch(`http://127.0.0.1:${port}/health`);
    await new Promise(r => setTimeout(r, 200));

    // Should still be alive (timer reset each time)
    expect(idleCalled).toBe(false);
    expect(daemon.idleTriggered).toBe(false);

    await daemon.stop();
  });
});

describe("daemon auth", () => {
  it("returns 401 for POST without auth token when tokenPath is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-authsrv-"));
    const tokenPath = join(dir, "daemon.token");
    ensureAuthToken(tokenPath);
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config, { tokenPath });
    const port = daemon.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi", cwd: dir }),
      });
      expect(res.status).toBe(401);
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows GET /health without auth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-authsrv2-"));
    const tokenPath = join(dir, "daemon.token");
    ensureAuthToken(tokenPath);
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config, { tokenPath });
    const port = daemon.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows POST with valid Bearer token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-authsrv3-"));
    const tokenPath = join(dir, "daemon.token");
    ensureAuthToken(tokenPath);
    const token = readAuthToken(tokenPath)!;
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config, { tokenPath });
    const port = daemon.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/store`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({ text: "hi", cwd: dir }),
      });
      expect(res.status).toBe(200);
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("daemon proxy integration", () => {
  let daemon: DaemonInstance | undefined;
  afterEach(async () => { if (daemon) { await daemon.stop(); daemon = undefined; } });

  it("accepts proxyManager option and calls start on daemon creation", async () => {
    const mockProxy = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      isHealthy: vi.fn().mockResolvedValue(true),
      port: 3456,
      available: true,
    };
    const config = loadDaemonConfig("/x", {
      daemon: { port: 0 },
      llm: { provider: "disabled" },
    });
    daemon = await createDaemon(config, { proxyManager: mockProxy });
    expect(mockProxy.start).toHaveBeenCalled();
  });

  it("calls proxyManager.stop() on daemon shutdown", async () => {
    const mockProxy = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      isHealthy: vi.fn().mockResolvedValue(true),
      port: 3456,
      available: true,
    };
    const config = loadDaemonConfig("/x", {
      daemon: { port: 0 },
      llm: { provider: "disabled" },
    });
    daemon = await createDaemon(config, { proxyManager: mockProxy });
    await daemon.stop();
    expect(mockProxy.stop).toHaveBeenCalled();
    daemon = undefined; // already stopped
  });

  it("continues without error when proxyManager.start() rejects", async () => {
    const mockProxy = {
      start: vi.fn().mockRejectedValue(new Error("spawn failed")),
      stop: vi.fn().mockResolvedValue(undefined),
      isHealthy: vi.fn().mockResolvedValue(false),
      port: 3456,
      available: false,
    };
    const config = loadDaemonConfig("/x", {
      daemon: { port: 0 },
      llm: { provider: "disabled" },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    daemon = await createDaemon(config, { proxyManager: mockProxy });
    // Daemon should still be running
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/health`);
    expect(res.status).toBe(200);
    warnSpy.mockRestore();
  });

  it("cleans up startup resources when listen fails", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const port = (blocker.address() as { port: number }).port;
    const mockProxy = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      isHealthy: vi.fn().mockResolvedValue(true),
      port: 3456,
      available: true,
    };
    const config = loadDaemonConfig("/x", {
      daemon: { port, idleTimeoutMs: 0 },
      llm: { provider: "disabled" },
    });

    try {
      await expect(createDaemon(config, { proxyManager: mockProxy })).rejects.toThrow(/EADDRINUSE|listen/);
      expect(mockProxy.start).toHaveBeenCalled();
      expect(mockProxy.stop).toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((err) => err ? reject(err) : resolve());
      });
    }
  });
});
