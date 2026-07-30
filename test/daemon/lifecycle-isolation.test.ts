import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDaemonLifecycleTestScope,
  isDaemonLifecycleTestIdentity,
  isDaemonLifecycleTestScope,
  isVitestWorkerEntrypoint,
  lifecycleScopeOwnsPath,
  lifecycleScopeUnitName,
  type DaemonLifecycleTestDependencies,
  type DaemonLifecycleTestScope,
} from "../../src/daemon/lifecycle-scope.js";
import { ensureDaemon, restartDaemon } from "../../src/daemon/lifecycle.js";
import { ensureAuthToken } from "../../src/daemon/auth.js";
import { createDaemon } from "../../src/daemon/server.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";

type ScopeFixture = {
  root: string;
  scope: DaemonLifecycleTestScope;
  pidPath: string;
  tokenPath: string;
  runSystemd: ReturnType<typeof vi.fn>;
  stopUnit: ReturnType<typeof vi.fn>;
  spawnProcess: ReturnType<typeof vi.fn>;
  killProcess: ReturnType<typeof vi.fn>;
  isAlive: ReturnType<typeof vi.fn>;
};

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createFixture(
  ownerId: string,
  overrides: Partial<DaemonLifecycleTestDependencies> = {},
): ScopeFixture {
  const root = mkdtempSync(join(tmpdir(), `lcm-lifecycle-scope-${ownerId}-`));
  roots.push(root);
  const homeDir = join(root, "home");
  const runtimeDir = join(homeDir, "runtime");
  const stateDir = join(homeDir, "state");
  const credentialDir = join(homeDir, "credentials");
  const entrypoint = join(runtimeDir, "owned-daemon.mjs");
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(credentialDir, { recursive: true });
  writeFileSync(entrypoint, "setTimeout(() => {}, 60_000);\n");

  let alive = true;
  const runSystemd = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
  const stopUnit = vi.fn(async () => undefined);
  const spawnProcess = vi.fn(() => ({
    pid: 42_424,
    once: vi.fn().mockReturnThis(),
    unref: vi.fn(),
  }));
  const killProcess = vi.fn((_pid: number) => {
    alive = false;
  });
  const isAlive = vi.fn(() => alive);
  const dependencies: DaemonLifecycleTestDependencies = {
    fetch: vi.fn().mockRejectedValue(new Error("offline")) as never,
    spawn: spawnProcess as never,
    spawnSync: runSystemd as never,
    stopUnit,
    killProcess,
    isProcessAlive: isAlive,
    sleep: async () => undefined,
    ...overrides,
  };
  const scope = createDaemonLifecycleTestScope({
    ownerId,
    homeDir,
    runtimeDir,
    stateDir,
    credentialDir,
    entrypoint,
    dependencies,
  });
  return {
    root,
    scope,
    pidPath: join(stateDir, "daemon.pid"),
    tokenPath: join(stateDir, "daemon.token"),
    runSystemd,
    stopUnit,
    spawnProcess,
    killProcess,
    isAlive,
  };
}

function scopedOptions(fixture: ScopeFixture): Parameters<typeof ensureDaemon>[0] {
  return {
    port: 48_321,
    pidFilePath: fixture.pidPath,
    spawnTimeoutMs: 25,
    expectedVersion: "1.4.2",
    enforceUserManagerParent: true,
    spawnCommand: process.execPath,
    spawnArgs: [fixture.scope.entrypoint],
    _platform: "linux",
    _testScope: fixture.scope,
    _skipHealthWait: true,
  };
}

describe("daemon lifecycle test-scope validation", () => {
  it("accepts only absolute, owned, non-worker identities and complete dependencies", () => {
    const fixture = createFixture("scope-valid");
    expect(isDaemonLifecycleTestScope(fixture.scope)).toBe(true);
    expect(isDaemonLifecycleTestIdentity({
      ownerId: fixture.scope.ownerId,
      entrypoint: fixture.scope.entrypoint,
    })).toBe(true);
    expect(isDaemonLifecycleTestIdentity(null)).toBe(false);
    expect(isDaemonLifecycleTestScope(null)).toBe(false);
    expect(isDaemonLifecycleTestIdentity({ ownerId: "bad owner", entrypoint: fixture.scope.entrypoint })).toBe(false);
    expect(isDaemonLifecycleTestIdentity({ ownerId: "ok", entrypoint: "relative.mjs" })).toBe(false);
    expect(isDaemonLifecycleTestIdentity({
      ownerId: "ok",
      entrypoint: "/repo/node_modules/vitest/dist/workers/forks.js",
    })).toBe(false);
    expect(isVitestWorkerEntrypoint("/repo/node_modules/vitest/dist/workers/forks.js")).toBe(true);
    expect(isVitestWorkerEntrypoint("/repo/lcm.mjs")).toBe(false);
    expect(lifecycleScopeOwnsPath(fixture.scope, fixture.pidPath)).toBe(true);
    expect(lifecycleScopeOwnsPath(fixture.scope, join(fixture.root, "foreign"))).toBe(false);
    expect(lifecycleScopeUnitName(fixture.scope, 12, 34)).toBe(
      "lcm-test-daemon-scope-valid-12-34",
    );
  });

  it.each([
    [{ ownerId: "bad owner" }, "ownerId"],
    [{ homeDir: "relative" }, "homeDir"],
    [{ runtimeDir: "/outside" }, "runtimeDir"],
    [{ entrypoint: "/repo/node_modules/vitest/dist/workers/forks.js" }, "entrypoint"],
    [{ dependencies: undefined }, "dependencies"],
  ])("rejects malformed scope component %#", (change, expected) => {
    const fixture = createFixture("scope-invalid");
    expect(() => createDaemonLifecycleTestScope({
      ...fixture.scope,
      ...change,
    } as never)).toThrow(expected);
  });

  it("rejects an owned Vitest entrypoint and a missing dependency", () => {
    const fixture = createFixture("scope-partial");
    const workerEntrypoint = join(
      fixture.scope.homeDir,
      "node_modules",
      "vitest",
      "dist",
      "workers",
      "forks.js",
    );
    expect(() => createDaemonLifecycleTestScope({
      ...fixture.scope,
      entrypoint: workerEntrypoint,
    })).toThrow("must not be a Vitest worker");
    const dependencies = { ...fixture.scope.dependencies } as Partial<DaemonLifecycleTestDependencies>;
    delete dependencies.stopUnit;
    expect(() => createDaemonLifecycleTestScope({
      ...fixture.scope,
      dependencies: dependencies as DaemonLifecycleTestDependencies,
    })).toThrow("stopUnit");
  });

  it("fails closed before invoking dependencies for a malformed or foreign scope", async () => {
    const fixture = createFixture("scope-closed");
    const malformed = {
      ...fixture.scope,
      dependencies: { ...fixture.scope.dependencies, stopUnit: undefined },
    };
    await expect(ensureDaemon({
      ...scopedOptions(fixture),
      _testScope: malformed as never,
    })).resolves.toMatchObject({
      connected: false,
      warning: expect.stringContaining("incomplete or malformed"),
    });
    await expect(ensureDaemon({
      ...scopedOptions(fixture),
      pidFilePath: join(fixture.root, "foreign", "daemon.pid"),
    })).resolves.toMatchObject({
      connected: false,
      warning: expect.stringContaining("outside the owned test scope"),
    });
    expect(fixture.runSystemd).not.toHaveBeenCalled();
    expect(fixture.spawnProcess).not.toHaveBeenCalled();
    expect(fixture.killProcess).not.toHaveBeenCalled();
  });

  it("blocks an unscoped Vitest worker before host discovery or mutation", async () => {
    expect(isVitestWorkerEntrypoint(process.argv[1])).toBe(true);
    const fetch = vi.spyOn(globalThis, "fetch");
    const kill = vi.spyOn(process, "kill");
    await expect(ensureDaemon({
      port: 37_337,
      pidFilePath: join(tmpdir(), "lcm-unscoped-worker", "daemon.pid"),
      spawnTimeoutMs: 10,
    })).resolves.toMatchObject({
      connected: false,
      spawned: false,
      warning: expect.stringContaining("unscoped Vitest worker"),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("fails closed for interruption, entrypoint mismatch, and worker entrypoints", async () => {
    const fixture = createFixture("scope-preflight");
    const controller = new AbortController();
    controller.abort();
    await expect(ensureDaemon({
      ...scopedOptions(fixture),
      _abortSignal: controller.signal,
    })).resolves.toMatchObject({
      connected: false,
      warning: expect.stringContaining("interrupted before startup"),
    });
    await expect(ensureDaemon({
      ...scopedOptions(fixture),
      expectedEntrypoint: join(fixture.scope.runtimeDir, "different.mjs"),
    })).resolves.toMatchObject({
      connected: false,
      warning: expect.stringContaining("does not match the owned test scope"),
    });
    await expect(ensureDaemon({
      port: 37_338,
      pidFilePath: join(fixture.root, "worker-entrypoint", "daemon.pid"),
      spawnTimeoutMs: 10,
      expectedEntrypoint: process.argv[1],
      _fetchOverride: vi.fn() as never,
    })).resolves.toMatchObject({
      connected: false,
      warning: expect.stringContaining("Vitest worker as a daemon entrypoint"),
    });
  });

  it("refuses to register the ambient Vitest worker during default startup", async () => {
    const fixture = createFixture("scope-spawn-worker");
    const stateBefore = readdirSync(fixture.scope.stateDir);
    expect(existsSync(fixture.pidPath)).toBe(false);
    expect(existsSync(fixture.tokenPath)).toBe(false);
    await expect(ensureDaemon({
      port: 37_339,
      pidFilePath: fixture.pidPath,
      spawnTimeoutMs: 10,
      expectedEntrypoint: fixture.scope.entrypoint,
      _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as never,
      _skipHealthWait: true,
    })).resolves.toMatchObject({
      connected: false,
      warning: expect.stringContaining("register a Vitest worker"),
    });
    expect(existsSync(fixture.pidPath)).toBe(false);
    expect(existsSync(fixture.tokenPath)).toBe(false);
    expect(readdirSync(fixture.scope.stateDir)).toEqual(stateBefore);
  });
});

describe("run-owned lifecycle resources", () => {
  it("uses only the scoped unit, paths, credentials, environment, and entrypoint", async () => {
    const fixture = createFixture("owned-success");
    const previousSecret = process.env.LCM_SUMMARY_API_KEY;
    process.env.LCM_SUMMARY_API_KEY = "scope-secret";
    try {
      const result = await ensureDaemon(scopedOptions(fixture));
      expect(result).toMatchObject({
        connected: false,
        spawned: true,
        startMethod: "systemd-user",
      });
    } finally {
      if (previousSecret === undefined) delete process.env.LCM_SUMMARY_API_KEY;
      else process.env.LCM_SUMMARY_API_KEY = previousSecret;
    }
    expect(fixture.runSystemd).toHaveBeenCalledOnce();
    const [, args, options] = fixture.runSystemd.mock.calls[0]!;
    const unitArg = (args as string[]).find(arg => arg.startsWith("--unit="));
    expect(unitArg).toMatch(/^--unit=lcm-test-daemon-owned-success-[0-9]+-[0-9]+$/u);
    expect(unitArg).not.toContain("--unit=lcm-daemon-");
    expect(args).toContain(`--setenv=HOME=${fixture.scope.homeDir}`);
    expect(args).toContain(`--setenv=LCM_DAEMON_OWNER_ID=${fixture.scope.ownerId}`);
    expect(args).toContain(`--setenv=XDG_RUNTIME_DIR=${fixture.scope.runtimeDir}`);
    expect(args).toContain(fixture.scope.entrypoint);
    expect(JSON.stringify(args)).not.toContain("scope-secret");
    expect(options.env.HOME).toBe(process.env.HOME);
    expect(options.env.XDG_RUNTIME_DIR).toBe(process.env.XDG_RUNTIME_DIR);
    expect(options.env.LCM_DAEMON_OWNER_ID).toBe(process.env.LCM_DAEMON_OWNER_ID);
    expect(options.env.LCM_SUMMARY_API_KEY).toBeUndefined();
    expect(fixture.stopUnit).toHaveBeenCalledExactlyOnceWith(unitArg!.slice("--unit=".length));
    expect(existsSync(fixture.scope.stateDir)).toBe(false);
    expect(existsSync(fixture.scope.runtimeDir)).toBe(false);
    expect(existsSync(fixture.scope.credentialDir)).toBe(false);
  });

  it("cleans the exact unit and fallback process after systemd failure", async () => {
    const fixture = createFixture("owned-failure");
    fixture.runSystemd.mockReturnValue({ status: 1, stdout: "", stderr: "failed" });
    const result = await ensureDaemon(scopedOptions(fixture));
    expect(result.startMethod).toBe("detached-spawn");
    expect(result.warning).toContain("used detached spawn fallback");
    expect(fixture.stopUnit).toHaveBeenCalledOnce();
    expect(fixture.spawnProcess).toHaveBeenCalledOnce();
    expect(fixture.killProcess).toHaveBeenCalledWith(42_424, "SIGTERM");
    expect(existsSync(fixture.scope.stateDir)).toBe(false);
  });

  it("cleans on a health timeout", async () => {
    const fixture = createFixture("owned-timeout");
    const result = await ensureDaemon({
      ...scopedOptions(fixture),
      spawnTimeoutMs: 3,
      _skipHealthWait: false,
    });
    expect(result).toMatchObject({ connected: false, spawned: true });
    expect(fixture.stopUnit).toHaveBeenCalledOnce();
    expect(existsSync(fixture.scope.stateDir)).toBe(false);
  });

  it("cleans immediately and reports interruption once", async () => {
    const controller = new AbortController();
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error("initially offline"))
      .mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
    const fixture = createFixture("owned-interrupt", {
      fetch: fetch as never,
    });
    const operation = ensureDaemon({
      ...scopedOptions(fixture),
      spawnTimeoutMs: 500,
      _skipHealthWait: false,
      _abortSignal: controller.signal,
    });
    await vi.waitFor(() => expect(fixture.runSystemd).toHaveBeenCalledOnce());
    controller.abort();
    await expect(operation).resolves.toMatchObject({
      connected: false,
      warning: "daemon lifecycle was interrupted",
    });
    expect(fixture.stopUnit).toHaveBeenCalledOnce();
    expect(existsSync(fixture.scope.stateDir)).toBe(false);
  });

  it("cleans when interrupted during transient-unit startup", async () => {
    const controller = new AbortController();
    const fixture = createFixture("owned-startup-interrupt");
    const scope = createDaemonLifecycleTestScope({
      ...fixture.scope,
      dependencies: {
        ...fixture.scope.dependencies,
        spawnSync: vi.fn(() => {
          controller.abort();
          return { status: 0, stdout: "", stderr: "" };
        }) as never,
      },
    });
    await expect(ensureDaemon({
      ...scopedOptions(fixture),
      _testScope: scope,
      _abortSignal: controller.signal,
    })).resolves.toMatchObject({
      connected: false,
      warning: "daemon lifecycle was interrupted",
    });
    expect(fixture.stopUnit).toHaveBeenCalledOnce();
    expect(existsSync(fixture.scope.stateDir)).toBe(false);
  });

  it("does not authenticate or signal an exact-port daemon owned by another scope", async () => {
    const fixture = createFixture("owned-a");
    const foreign = createFixture("owned-b");
    writeFileSync(fixture.pidPath, "5151");
    ensureAuthToken(fixture.tokenPath);
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        version: "1.4.2",
        pid: 5151,
        ownerId: foreign.scope.ownerId,
      }),
    }));
    const scope = createDaemonLifecycleTestScope({
      ...fixture.scope,
      dependencies: {
        ...fixture.scope.dependencies,
        fetch: fetch as never,
        isProcessAlive: () => true,
      },
    });
    const result = await ensureDaemon({
      ...scopedOptions(fixture),
      _testScope: scope,
      _skipSpawn: true,
      _listeningPortsOverride: () => [48_321],
    });
    expect(result.connected).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.stopUnit).not.toHaveBeenCalled();
  });

  it("keeps two independent scopes from discovering or cleaning each other", async () => {
    const left = createFixture("parallel-left");
    const right = createFixture("parallel-right");
    const [leftResult, rightResult] = await Promise.all([
      ensureDaemon(scopedOptions(left)),
      ensureDaemon(scopedOptions(right)),
    ]);
    expect(leftResult.startMethod).toBe("systemd-user");
    expect(rightResult.startMethod).toBe("systemd-user");
    const leftUnit = (left.runSystemd.mock.calls[0]![1] as string[])
      .find(arg => arg.startsWith("--unit="))!;
    const rightUnit = (right.runSystemd.mock.calls[0]![1] as string[])
      .find(arg => arg.startsWith("--unit="))!;
    expect(leftUnit).not.toBe(rightUnit);
    expect(left.stopUnit).toHaveBeenCalledExactlyOnceWith(leftUnit.slice(7));
    expect(right.stopUnit).toHaveBeenCalledExactlyOnceWith(rightUnit.slice(7));
    expect(left.stopUnit).not.toHaveBeenCalledWith(rightUnit.slice(7));
    expect(right.stopUnit).not.toHaveBeenCalledWith(leftUnit.slice(7));
    expect(existsSync(left.scope.stateDir)).toBe(false);
    expect(existsSync(right.scope.stateDir)).toBe(false);
  });

  it("fails closed when restart scope state or ownership is invalid", async () => {
    const fixture = createFixture("restart-owned");
    const malformed = {
      ...fixture.scope,
      dependencies: { ...fixture.scope.dependencies, stopUnit: undefined },
    };
    await expect(restartDaemon({
      ...scopedOptions(fixture),
      _testScope: malformed as never,
    })).resolves.toMatchObject({
      restarted: false,
      warning: expect.stringContaining("incomplete or malformed"),
    });
    await expect(restartDaemon({
      ...scopedOptions(fixture),
      pidFilePath: join(fixture.root, "foreign", "daemon.pid"),
    })).resolves.toMatchObject({
      restarted: false,
      warning: expect.stringContaining("outside the owned test scope"),
    });
    await expect(restartDaemon({
      port: 37_340,
      pidFilePath: join(fixture.root, "unscoped", "daemon.pid"),
      spawnTimeoutMs: 10,
    })).resolves.toMatchObject({
      restarted: false,
      warning: expect.stringContaining("unscoped Vitest worker"),
    });
  });

  it("never restarts a live daemon owned by another scope", async () => {
    const fixture = createFixture("restart-left");
    const foreign = createFixture("restart-right");
    writeFileSync(fixture.pidPath, "6262");
    ensureAuthToken(fixture.tokenPath);
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        version: "1.4.2",
        storageBackend: "sqlite",
        pid: 6262,
        ownerId: foreign.scope.ownerId,
      }),
    }));
    const scope = createDaemonLifecycleTestScope({
      ...fixture.scope,
      dependencies: {
        ...fixture.scope.dependencies,
        fetch: fetch as never,
        isProcessAlive: () => true,
      },
    });
    await expect(restartDaemon({
      ...scopedOptions(fixture),
      _testScope: scope,
      _platform: "darwin",
      _listeningPortsOverride: () => [48_321],
    })).rejects.toThrow("not a verified LCM daemon");
    expect(fixture.killProcess).not.toHaveBeenCalled();
  });

  it("restarts only a matching owned daemon and reports the exact stopped PID", async () => {
    const fixture = createFixture("restart-matching");
    writeFileSync(fixture.pidPath, "7373");
    ensureAuthToken(fixture.tokenPath);
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        version: "1.4.2",
        storageBackend: "sqlite",
        pid: 7373,
        ownerId: fixture.scope.ownerId,
        entrypoint: fixture.scope.entrypoint,
      }),
    }));
    const scope = createDaemonLifecycleTestScope({
      ...fixture.scope,
      dependencies: {
        ...fixture.scope.dependencies,
        fetch: fetch as never,
      },
    });
    const replacement = vi.fn(async () => ({
      connected: false,
      port: 48_321,
      spawned: true,
      startMethod: "systemd-user" as const,
    }));
    await expect(restartDaemon({
      ...scopedOptions(fixture),
      _testScope: scope,
      _platform: "darwin",
      _listeningPortsOverride: () => [48_321],
      _ensureDaemonOverride: replacement,
    })).resolves.toMatchObject({
      restarted: true,
      stoppedPid: 7373,
      spawned: true,
    });
    expect(fixture.killProcess).toHaveBeenCalledWith(7373, "SIGTERM");
    expect(replacement).toHaveBeenCalledOnce();
  });

  it("rejects worker authentication and an already-interrupted restart", async () => {
    const workerFixture = createFixture("restart-worker");
    writeFileSync(workerFixture.pidPath, "7474");
    ensureAuthToken(workerFixture.tokenPath);
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        version: "1.4.2",
        storageBackend: "sqlite",
        pid: 7474,
        ownerId: workerFixture.scope.ownerId,
        entrypoint: process.argv[1],
      }),
    }));
    const workerScope = createDaemonLifecycleTestScope({
      ...workerFixture.scope,
      dependencies: {
        ...workerFixture.scope.dependencies,
        fetch: fetch as never,
      },
    });
    await expect(restartDaemon({
      ...scopedOptions(workerFixture),
      _testScope: workerScope,
      _platform: "darwin",
      _listeningPortsOverride: () => [48_321],
    })).rejects.toThrow("not a verified LCM daemon");
    expect(workerFixture.killProcess).not.toHaveBeenCalled();

    const interruptedFixture = createFixture("restart-interrupted");
    writeFileSync(interruptedFixture.pidPath, "7575");
    const controller = new AbortController();
    controller.abort();
    await expect(restartDaemon({
      ...scopedOptions(interruptedFixture),
      _platform: "darwin",
      _listeningPortsOverride: () => [48_321],
      _abortSignal: controller.signal,
    })).rejects.toThrow("not a verified LCM daemon");
    expect(interruptedFixture.scope.dependencies.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.objectContaining({ aborted: true }) }),
    );
    expect(interruptedFixture.killProcess).not.toHaveBeenCalled();

    const elapsedFixture = createFixture("restart-deadline");
    writeFileSync(elapsedFixture.pidPath, "7676");
    const monotonicNow = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValue(11);
    await expect(restartDaemon({
      ...scopedOptions(elapsedFixture),
      spawnTimeoutMs: 10,
      _platform: "darwin",
      _listeningPortsOverride: () => [48_321],
      _monotonicNowOverride: monotonicNow,
    })).rejects.toThrow("not a verified LCM daemon");
    expect(elapsedFixture.killProcess).not.toHaveBeenCalled();
  });
});

describe("authenticated daemon identity", () => {
  it("rejects worker and malformed authenticated identities before listening", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-worker-auth-"));
    roots.push(dir);
    const tokenPath = join(dir, "daemon.token");
    ensureAuthToken(tokenPath);
    const config = loadDaemonConfig("/missing", { daemon: { port: 0, idleTimeoutMs: 0 } });
    await expect(createDaemon(config, { tokenPath })).rejects.toThrow("Vitest worker");
    await expect(createDaemon(config, {
      tokenPath,
      _testIdentity: { ownerId: "partial" } as never,
    })).rejects.toThrow("incomplete or malformed");
  });

  it("preserves the production public-health shape without a scoped owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-production-auth-"));
    roots.push(dir);
    const tokenPath = join(dir, "daemon.token");
    ensureAuthToken(tokenPath);
    const previousEntrypoint = process.argv[1];
    process.argv[1] = join(dir, "lcm.mjs");
    let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined;
    try {
      daemon = await createDaemon(
        loadDaemonConfig("/missing", { daemon: { port: 0, idleTimeoutMs: 0 } }),
        { tokenPath },
      );
      const port = daemon.address().port;
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      const health = await response.json() as Record<string, unknown>;
      expect(response.status).toBe(200);
      expect(health).not.toHaveProperty("ownerId");
      expect(health).not.toHaveProperty("entrypoint");
    } finally {
      process.argv[1] = previousEntrypoint;
      await daemon?.stop();
    }
  });
});

describe("same-user-systemd integration", () => {
  it("uses and removes one exact run-owned transient unit", async () => {
    const integration = process.env.LCM_LIFECYCLE_SYSTEMD_INTEGRATION === "1";
    const ownerId = process.env.LCM_LIFECYCLE_SCOPE_ID
      ?? `modeled-${process.pid}`;
    if (!integration) {
      const fixture = createFixture(ownerId);
      await expect(ensureDaemon(scopedOptions(fixture))).resolves.toMatchObject({
        startMethod: "systemd-user",
      });
      expect(fixture.stopUnit).toHaveBeenCalledOnce();
      return;
    }

    const root = mkdtempSync(join(tmpdir(), `lcm-systemd-integration-${ownerId}-`));
    roots.push(root);
    const homeDir = join(root, "home");
    const runtimeDir = join(homeDir, "runtime");
    const stateDir = join(homeDir, "state");
    const credentialDir = join(homeDir, "credentials");
    const entrypoint = join(runtimeDir, "owned-daemon.mjs");
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(credentialDir, { recursive: true });
    writeFileSync(entrypoint, "setTimeout(() => {}, 60_000);\n");
    let unitName = "";
    const stopUnit = async (unit: string): Promise<void> => {
      expect(unit).toBe(unitName);
      spawnSync("systemctl", ["--user", "stop", unit], { encoding: "utf-8", timeout: 10_000 });
      for (let attempt = 0; attempt < 100; attempt++) {
        const status = spawnSync(
          "systemctl",
          ["--user", "show", unit, "--property=LoadState", "--value"],
          { encoding: "utf-8", timeout: 10_000 },
        );
        if (String(status.stdout).trim() === "not-found") return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error(`run-owned systemd unit was not collected: ${unit}`);
    };
    const runSystemd = ((command: string, args: readonly string[], options: object) => {
      unitName = args.find(arg => arg.startsWith("--unit="))!.slice(7);
      const result = spawnSync(command, args, options);
      const barrierDir = process.env.LCM_LIFECYCLE_SYSTEMD_BARRIER_DIR;
      const expectedScopes = Number(process.env.LCM_LIFECYCLE_EXPECTED_SCOPES ?? "1");
      if (result.status !== 0 || barrierDir === undefined || expectedScopes <= 1) return result;

      mkdirSync(barrierDir, { recursive: true });
      writeFileSync(join(barrierDir, `${ownerId}.ready`), `${unitName}\n`);
      const pause = (): void => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      };
      const waitForMarkers = (suffix: string): string[] => {
        for (let attempt = 0; attempt < 500; attempt++) {
          const markers = readdirSync(barrierDir)
            .filter(name => name.endsWith(suffix))
            .sort();
          if (markers.length === expectedScopes) return markers;
          pause();
        }
        throw new Error(`timed out waiting for ${expectedScopes} lifecycle ${suffix} markers`);
      };
      const ready = waitForMarkers(".ready");
      const units = ready.map(marker => readFileSync(join(barrierDir, marker), "utf-8").trim());
      expect(new Set(units).size).toBe(expectedScopes);
      for (const ownedUnit of units) {
        expect(ownedUnit).toMatch(/^lcm-test-daemon-/u);
        let active = false;
        for (let attempt = 0; attempt < 250; attempt++) {
          const status = spawnSync(
            "systemctl",
            ["--user", "show", ownedUnit, "--property=ActiveState", "--value"],
            { encoding: "utf-8", timeout: 10_000 },
          );
          if (status.status === 0 && String(status.stdout).trim() === "active") {
            active = true;
            break;
          }
          pause();
        }
        expect(active).toBe(true);
      }
      writeFileSync(join(barrierDir, `${ownerId}.checked`), `${unitName}\n`);
      waitForMarkers(".checked");
      return result;
    }) as typeof spawnSync;
    const scope = createDaemonLifecycleTestScope({
      ownerId,
      homeDir,
      runtimeDir,
      stateDir,
      credentialDir,
      entrypoint,
      dependencies: {
        fetch: vi.fn().mockRejectedValue(new Error("not used")) as never,
        spawn,
        spawnSync: runSystemd,
        stopUnit,
        killProcess: process.kill.bind(process),
        isProcessAlive: () => false,
        sleep: async ms => new Promise(resolve => setTimeout(resolve, ms)),
      },
    });
    const result = await ensureDaemon({
      port: 48_322,
      pidFilePath: join(stateDir, "daemon.pid"),
      spawnTimeoutMs: 10_000,
      expectedVersion: "1.4.2",
      enforceUserManagerParent: true,
      spawnCommand: process.execPath,
      spawnArgs: [entrypoint],
      _platform: "linux",
      _testScope: scope,
      _skipHealthWait: true,
    });
    expect(result.startMethod).toBe("systemd-user");
    expect(unitName).toMatch(new RegExp(`^${scope.unitPrefix}[0-9]+-[0-9]+$`, "u"));
    expect(unitName).not.toMatch(/^lcm-daemon-/u);
    expect(existsSync(stateDir)).toBe(false);
    expect(existsSync(runtimeDir)).toBe(false);
    expect(existsSync(credentialDir)).toBe(false);
    console.info("[lcm lifecycle isolation]", JSON.stringify({
      ownerId,
      unitName,
      homeDir,
      runtimeDir,
      stateDir,
      credentialDir,
    }));
  }, 20_000);
});
