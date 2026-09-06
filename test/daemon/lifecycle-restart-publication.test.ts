import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureDaemon,
  restartDaemon,
  type EnsureDaemonOptions,
  type RestartDaemonOptions,
} from "../../src/daemon/lifecycle.js";
import {
  createDaemonLifecycleTestScope,
  type DaemonLifecycleHermeticTestSeams,
} from "../../src/daemon/lifecycle-scope.js";
import type { Supervisor, SupervisorObservation, SupervisorSpec } from "../../src/daemon/supervisor.js";
import { PrivateMutationLockContentionError } from "../../src/private-mutation-lock.js";

const publicationFsFault = vi.hoisted(() => ({
  pidPath: undefined as string | undefined,
  replaceStateAfterPidOpen: false,
  abortAfterPidOpen: undefined as AbortController | undefined,
  pidOpens: 0,
  tokenPath: undefined as string | undefined,
  rotateTokenOnSecondOpen: false,
  tokenOpens: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const path = String(args[0]);
      if (path === publicationFsFault.tokenPath) {
        publicationFsFault.tokenOpens += 1;
        if (publicationFsFault.rotateTokenOnSecondOpen && publicationFsFault.tokenOpens === 2) {
          actual.writeFileSync(path, "rotated-token", { mode: 0o600 });
        }
      }
      const descriptor = actual.openSync(...args);
      if (path === publicationFsFault.pidPath) {
        publicationFsFault.pidOpens += 1;
        if (publicationFsFault.replaceStateAfterPidOpen && publicationFsFault.pidOpens === 1) {
          const stateDir = dirname(path);
          actual.renameSync(stateDir, `${stateDir}.replaced`);
          actual.mkdirSync(stateDir, { mode: 0o700 });
          actual.writeFileSync(path, "111", { mode: 0o600 });
          actual.writeFileSync(join(stateDir, "daemon.token"), "replacement-token", { mode: 0o600 });
        }
        if (publicationFsFault.abortAfterPidOpen !== undefined && publicationFsFault.pidOpens === 2) {
          publicationFsFault.abortAfterPidOpen.abort();
        }
      }
      return descriptor;
    },
  };
});

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  publicationFsFault.pidPath = undefined;
  publicationFsFault.replaceStateAfterPidOpen = false;
  publicationFsFault.abortAfterPidOpen = undefined;
  publicationFsFault.pidOpens = 0;
  publicationFsFault.tokenPath = undefined;
  publicationFsFault.rotateTokenOnSecondOpen = false;
  publicationFsFault.tokenOpens = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fixture(): {
  root: string;
  pidPath: string;
  tokenPath: string;
  seams: DaemonLifecycleHermeticTestSeams;
} {
  const root = mkdtempSync(join(tmpdir(), "lcm-950-restart-publication-"));
  roots.push(root);
  const stateDir = join(root, ".lcm");
  const runtimeDir = join(root, "runtime");
  const credentialDir = join(root, "credentials");
  const procRoot = join(root, "proc");
  for (const path of [stateDir, runtimeDir, credentialDir, procRoot]) mkdirSync(path, { recursive: true });
  chmodSync(stateDir, 0o700);
  chmodSync(credentialDir, 0o700);
  const pidPath = join(stateDir, "daemon.pid");
  const tokenPath = join(stateDir, "daemon.token");
  const seams: DaemonLifecycleHermeticTestSeams = {
    homeDir: root,
    runtimeDir,
    stateDir,
    credentialDir,
    procRoot,
    platform: "linux",
    uid: 1000,
    environment: {},
    fetch: vi.fn(),
    spawn: vi.fn() as never,
    spawnSync: vi.fn() as never,
    stopUnit: vi.fn(),
    killProcess: vi.fn(),
    isProcessAlive: vi.fn(() => true),
    sleep: vi.fn(async () => undefined),
    realpath: (path) => path,
  };
  return { root, pidPath, tokenPath, seams };
}

function health(
  pid: number,
  version: string,
  storageBackend: "sqlite" | "postgresql",
  entrypoint?: string,
  runtimeDigest?: string,
): Record<string, unknown> {
  return {
    status: "ok",
    pid,
    version,
    storageBackend,
    ...(entrypoint === undefined ? {} : { entrypoint }),
    ...(runtimeDigest === undefined ? {} : { runtimeDigest }),
  };
}

function options(
  f: ReturnType<typeof fixture>,
  overrides: Partial<RestartDaemonOptions> = {},
): RestartDaemonOptions {
  return {
    port: 43_950,
    pidFilePath: f.pidPath,
    spawnTimeoutMs: 100,
    expectedVersion: "2.0.0",
    expectedStorageBackend: "sqlite",
    expectedEntrypoint: "/opt/lcm.mjs",
    expectedRuntimeDigest: "b".repeat(64),
    _hermeticTestSeams: f.seams,
    _isManagedProcessOverride: () => true,
    ...overrides,
  };
}

function scopedOptions(f: ReturnType<typeof fixture>): RestartDaemonOptions {
  const entrypoint = join(f.seams.runtimeDir, "owned-daemon.mjs");
  writeFileSync(entrypoint, "setTimeout(() => undefined, 60_000);\n");
  const scope = createDaemonLifecycleTestScope({
    ownerId: "bug-950-owner",
    homeDir: f.root,
    runtimeDir: f.seams.runtimeDir,
    stateDir: f.seams.stateDir,
    credentialDir: f.seams.credentialDir,
    entrypoint,
    dependencies: {
      fetch: f.seams.fetch,
      spawn: f.seams.spawn,
      spawnSync: f.seams.spawnSync,
      stopUnit: f.seams.stopUnit,
      killProcess: f.seams.killProcess,
      isProcessAlive: f.seams.isProcessAlive,
      sleep: f.seams.sleep,
    },
  });
  const { _hermeticTestSeams: _seams, ...base } = options(f, { expectedEntrypoint: entrypoint });
  void _seams;
  return { ...base, _testScope: scope };
}

describe("restart publication assertion convergence", () => {
  it("propagates ordinary outer publication errors without capture", async () => {
    const f = fixture();
    const failure = new Error("ordinary publication failure");

    await expect(restartDaemon(options(f, {
      _processStartTimeForTesting: vi.fn(),
      _readPrivateMutationLockOwnerForTesting: vi.fn(),
      _assertBackendPublication: () => { throw failure; },
    }))).rejects.toBe(failure);

    expect(f.seams.fetch).not.toHaveBeenCalled();
    expect(f.seams.isProcessAlive).not.toHaveBeenCalled();
  });

  it("does not add capture probes when restart assertions are uncontended", async () => {
    const f = fixture();
    const ensure = vi.fn(async (ensureOptions: EnsureDaemonOptions) => ({
      connected: false,
      port: ensureOptions.port,
      spawned: true,
    }));
    let assertions = 0;

    await restartDaemon(options(f, {
      _ensureDaemonOverride: ensure,
      _processStartTimeForTesting: vi.fn(),
      _readPrivateMutationLockOwnerForTesting: vi.fn(),
      _assertBackendPublication: () => { assertions += 1; },
    }));

    expect(assertions).toBe(2);
    expect(ensure).toHaveBeenCalledOnce();
    expect(f.seams.fetch).not.toHaveBeenCalled();
    expect(f.seams.isProcessAlive).not.toHaveBeenCalled();
  });

  it("keeps the restart wrapper on the initial ensure assertion only", async () => {
    const f = fixture();
    const restartInitial = vi.fn(async <T>(step: () => T | Promise<T>) => await step());
    const caller = vi.fn(async <T>(step: () => T | Promise<T>) => await step());
    let assertions = 0;

    await ensureDaemon({
      ...options(f),
      _skipSpawn: true,
      _skipHealthWait: true,
      _withInitialPublicationAdmissionRetry: restartInitial,
      _withPublicationAdmissionRetry: caller,
      _assertBackendPublication: () => { assertions += 1; },
    });

    expect(assertions).toBe(2);
    expect(restartInitial).toHaveBeenCalledOnce();
    expect(caller).toHaveBeenCalledOnce();
  });

  it("waits for authenticated current-daemon contention without replaying restart", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    let now = 0;
    let assertions = 0;
    let alive = true;
    const currentPublic = health(111, "1.0.0", "postgresql");
    const currentAuthenticated = health(
      111,
      "1.0.0",
      "postgresql",
      "/opt/lcm.mjs",
      "a".repeat(64),
    );
    f.seams.fetch = vi.fn()
      .mockResolvedValueOnce(response(currentPublic))
      .mockResolvedValueOnce(response(currentAuthenticated))
      .mockResolvedValueOnce(response({ totalConnections: 0 }))
      .mockResolvedValueOnce(response(currentAuthenticated));
    f.seams.isProcessAlive = vi.fn(() => alive);
    f.seams.killProcess = vi.fn(() => { alive = false; });
    f.seams.sleep = vi.fn(async (delayMs) => { now += delayMs; });
    const ensure = vi.fn(async (ensureOptions: EnsureDaemonOptions) => ({
      connected: false,
      port: ensureOptions.port,
      spawned: true,
    }));
    const contention = new PrivateMutationLockContentionError("current sweep owns publication");

    const result = await restartDaemon(options(f, {
      _monotonicNowOverride: () => now,
      _ensureDaemonOverride: ensure,
      _processStartTimeForTesting: (pid) => `birth-${pid}`,
      _readPrivateMutationLockOwnerForTesting: () => ({
        version: 1,
        pid: 111,
        processStartTime: "birth-111",
        nonce: "a".repeat(32),
      }),
      _assertBackendPublication: () => {
        assertions += 1;
        if (assertions === 1) throw contention;
      },
    }));

    expect(result).toMatchObject({ restarted: true, stoppedPid: 111 });
    expect(assertions).toBe(3);
    expect(ensure).toHaveBeenCalledOnce();
    expect(f.seams.killProcess).toHaveBeenCalledOnce();
  });

  it("waits for authenticated replacement contention after one restart mutation", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    let now = 0;
    let assertions = 0;
    let alive = true;
    let replacement = false;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const selected = replacement
        ? health(222, "2.0.0", "sqlite", "/opt/lcm.mjs", "b".repeat(64))
        : health(111, "1.0.0", "postgresql", "/opt/lcm.mjs", "a".repeat(64));
      if (String(_input).endsWith("/stats/pool")) return response({ totalConnections: 0 });
      return response(init?.headers === undefined
        ? health(selected.pid as number, selected.version as string, selected.storageBackend as "sqlite" | "postgresql")
        : selected);
    });
    f.seams.fetch = fetch as never;
    f.seams.isProcessAlive = vi.fn((pid) => pid === 222 || (pid === 111 && alive));
    f.seams.killProcess = vi.fn(() => { alive = false; });
    f.seams.sleep = vi.fn(async (delayMs) => { now += delayMs; });
    const ensure = vi.fn(async (ensureOptions: EnsureDaemonOptions) => {
      replacement = true;
      writeFileSync(f.pidPath, "222", { mode: 0o600 });
      writeFileSync(f.tokenPath, "replacement-token", { mode: 0o600 });
      return { connected: true, port: ensureOptions.port, spawned: true, pid: 222 };
    });
    const contention = new PrivateMutationLockContentionError("replacement sweep owns publication");

    const result = await restartDaemon(options(f, {
      _monotonicNowOverride: () => now,
      _ensureDaemonOverride: ensure,
      _processStartTimeForTesting: (pid) => `birth-${pid}`,
      _readPrivateMutationLockOwnerForTesting: () => ({
        version: 1,
        pid: 222,
        processStartTime: "birth-222",
        nonce: "b".repeat(32),
      }),
      _assertBackendPublication: () => {
        assertions += 1;
        if (assertions === 2) throw contention;
      },
    }));

    expect(result).toMatchObject({ connected: true, restarted: true, stoppedPid: 111, pid: 222 });
    expect(assertions).toBe(3);
    expect(ensure).toHaveBeenCalledOnce();
    expect(f.seams.killProcess).toHaveBeenCalledOnce();
  });

  it("refuses current-daemon convergence when authenticated entrypoint differs", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    const publicHealth = health(111, "1.0.0", "postgresql");
    f.seams.fetch = vi.fn()
      .mockResolvedValueOnce(response(publicHealth))
      .mockResolvedValueOnce(response(health(
        111,
        "1.0.0",
        "postgresql",
        "/foreign.mjs",
        "a".repeat(64),
      )))
      .mockResolvedValueOnce(response({ totalConnections: 0 })) as never;
    f.seams.isProcessAlive = vi.fn(() => true);
    const ensure = vi.fn();
    const contention = new PrivateMutationLockContentionError("entrypoint mismatch contention");

    await expect(restartDaemon(options(f, {
      _ensureDaemonOverride: ensure,
      _processStartTimeForTesting: () => "birth-111",
      _readPrivateMutationLockOwnerForTesting: vi.fn(),
      _assertBackendPublication: () => { throw contention; },
    }))).rejects.toBe(contention);

    expect(ensure).not.toHaveBeenCalled();
    expect(f.seams.killProcess).not.toHaveBeenCalled();
  });

  it("conservatively refuses staged PostgreSQL health during retry identity checks", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    const staged = {
      ...health(111, "1.0.0", "postgresql", "/opt/lcm.mjs", "a".repeat(64)),
      status: "unavailable",
      uptime: 1,
      storage: {
        status: "unavailable",
        error: {
          code: "STORAGE_INITIALIZATION_FAILED",
          backend: "postgresql",
          domain: "factory",
          operation: "health",
        },
      },
    };
    f.seams.fetch = vi.fn()
      .mockResolvedValueOnce(response(health(111, "1.0.0", "postgresql")))
      .mockResolvedValueOnce(response(staged, 503))
      .mockResolvedValueOnce(response({
        code: "STORAGE_BACKEND_STAGED",
        storageBackend: "postgresql",
      }, 503))
      .mockResolvedValueOnce(response(staged, 503)) as never;
    f.seams.isProcessAlive = vi.fn(() => true);
    const contention = new PrivateMutationLockContentionError("staged PostgreSQL contention");
    let assertions = 0;

    await expect(restartDaemon(options(f, {
      _processStartTimeForTesting: () => "birth-111",
      _readPrivateMutationLockOwnerForTesting: () => ({
        version: 1,
        pid: 111,
        processStartTime: "birth-111",
        nonce: "d".repeat(32),
      }),
      _assertBackendPublication: () => {
        assertions += 1;
        throw contention;
      },
    }))).rejects.toBe(contention);

    expect(assertions).toBe(1);
    expect(f.seams.killProcess).not.toHaveBeenCalled();
  });

  it("does not disclose the token when public PID identity mismatches", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "must-not-disclose", { mode: 0o600 });
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toBeUndefined();
      return response(health(999, "1.0.0", "sqlite"));
    });
    f.seams.fetch = fetch as never;
    f.seams.isProcessAlive = vi.fn(() => true);
    const contention = new PrivateMutationLockContentionError("public mismatch contention");

    await expect(restartDaemon(options(f, {
      _processStartTimeForTesting: () => "birth-111",
      _readPrivateMutationLockOwnerForTesting: vi.fn(),
      _assertBackendPublication: () => { throw contention; },
    }))).rejects.toBe(contention);

    expect(fetch).toHaveBeenCalledOnce();
    expect(f.seams.killProcess).not.toHaveBeenCalled();
  });

  it("does not disclose the token when scoped public owner identity mismatches", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "must-not-disclose", { mode: 0o600 });
    f.seams.isProcessAlive = vi.fn(() => true);
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toBeUndefined();
      return response({ ...health(111, "1.0.0", "sqlite"), ownerId: "foreign-owner" });
    });
    f.seams.fetch = fetch as never;
    const contention = new PrivateMutationLockContentionError("owner mismatch contention");

    await expect(restartDaemon({
      ...scopedOptions(f),
      _processStartTimeForTesting: () => "birth-111",
      _readPrivateMutationLockOwnerForTesting: vi.fn(),
      _assertBackendPublication: () => { throw contention; },
    })).rejects.toBe(contention);

    expect(fetch).toHaveBeenCalledOnce();
  });

  it("declines when hermetic process-birth evidence uses the default null probe", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    f.seams.isProcessAlive = vi.fn(() => true);
    const contention = new PrivateMutationLockContentionError("missing birth evidence");

    await expect(restartDaemon(options(f, {
      _assertBackendPublication: () => { throw contention; },
    }))).rejects.toBe(contention);

    expect(f.seams.fetch).not.toHaveBeenCalled();
    expect(f.seams.killProcess).not.toHaveBeenCalled();
  });

  it("declines when publication lock ownership differs from the pinned PID", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    f.seams.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/stats/pool")) return response({ totalConnections: 0 });
      return response(init?.headers === undefined
        ? health(111, "1.0.0", "sqlite")
        : health(111, "1.0.0", "sqlite", "/opt/lcm.mjs", "a".repeat(64)));
    }) as never;
    f.seams.isProcessAlive = vi.fn(() => true);
    const contention = new PrivateMutationLockContentionError("foreign lock owner");
    let assertions = 0;

    await expect(restartDaemon(options(f, {
      _processStartTimeForTesting: () => "birth-111",
      _readPrivateMutationLockOwnerForTesting: () => ({
        version: 1,
        pid: 999,
        processStartTime: "birth-999",
        nonce: "1".repeat(32),
      }),
      _assertBackendPublication: () => {
        assertions += 1;
        throw contention;
      },
    }))).rejects.toBe(contention);

    expect(assertions).toBe(1);
    expect(f.seams.fetch).toHaveBeenCalledTimes(3);
  });

  it("declines when the pinned token rotates before retry authentication", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    f.seams.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/stats/pool")) return response({ totalConnections: 0 });
      return response(init?.headers === undefined
        ? health(111, "1.0.0", "sqlite")
        : health(111, "1.0.0", "sqlite", "/opt/lcm.mjs", "a".repeat(64)));
    }) as never;
    f.seams.isProcessAlive = vi.fn(() => true);
    const contention = new PrivateMutationLockContentionError("rotated token");

    await expect(restartDaemon(options(f, {
      _processStartTimeForTesting: () => "birth-111",
      _readPrivateMutationLockOwnerForTesting: () => {
        writeFileSync(f.tokenPath, "rotated-token", { mode: 0o600 });
        return {
          version: 1,
          pid: 111,
          processStartTime: "birth-111",
          nonce: "2".repeat(32),
        };
      },
      _assertBackendPublication: () => { throw contention; },
    }))).rejects.toBe(contention);

    expect(f.seams.fetch).toHaveBeenCalledTimes(3);
  });

  it("declines when PID state drifts after authenticated capture", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    f.seams.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/stats/pool")) {
        writeFileSync(f.pidPath, "222", { mode: 0o600 });
        return response({ totalConnections: 0 });
      }
      return response(init?.headers === undefined
        ? health(111, "1.0.0", "sqlite")
        : health(111, "1.0.0", "sqlite", "/opt/lcm.mjs", "a".repeat(64)));
    }) as never;
    f.seams.isProcessAlive = vi.fn(() => true);
    const contention = new PrivateMutationLockContentionError("PID drift");

    await expect(restartDaemon(options(f, {
      _processStartTimeForTesting: () => "birth-111",
      _readPrivateMutationLockOwnerForTesting: vi.fn(),
      _assertBackendPublication: () => { throw contention; },
    }))).rejects.toBe(contention);

    expect(f.seams.fetch).toHaveBeenCalledTimes(3);
  });

  it("declines when the owned PID file is replaced by the same numeric PID", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    f.seams.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/stats/pool")) {
        renameSync(f.pidPath, `${f.pidPath}.old`);
        writeFileSync(f.pidPath, "111", { mode: 0o600 });
        return response({ totalConnections: 0 });
      }
      return response(init?.headers === undefined
        ? health(111, "1.0.0", "sqlite")
        : health(111, "1.0.0", "sqlite", "/opt/lcm.mjs", "a".repeat(64)));
    }) as never;
    f.seams.isProcessAlive = vi.fn(() => true);
    const contention = new PrivateMutationLockContentionError("same PID replacement");
    let assertions = 0;

    await expect(restartDaemon(options(f, {
      _processStartTimeForTesting: () => "birth-111",
      _readPrivateMutationLockOwnerForTesting: () => ({
        version: 1,
        pid: 111,
        processStartTime: "birth-111",
        nonce: "3".repeat(32),
      }),
      _assertBackendPublication: () => {
        assertions += 1;
        if (assertions === 1) throw contention;
      },
    }))).rejects.toBe(contention);

    expect(assertions).toBe(1);
    expect(f.seams.killProcess).not.toHaveBeenCalled();
  });

  it("declines when scoped state ownership changes during the PID read", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    f.seams.isProcessAlive = vi.fn(() => true);
    publicationFsFault.pidPath = f.pidPath;
    publicationFsFault.replaceStateAfterPidOpen = true;
    const contention = new PrivateMutationLockContentionError("state ownership drift");

    await expect(restartDaemon(options(f, {
      _processStartTimeForTesting: vi.fn(),
      _assertBackendPublication: () => { throw contention; },
    }))).rejects.toBe(contention);

    expect(f.seams.fetch).not.toHaveBeenCalled();
    expect(f.seams.isProcessAlive).not.toHaveBeenCalled();
  });

  it.each([
    "status",
    "pid",
    "version",
    "storageBackend",
    "entrypoint",
    "runtimeDigest",
  ] as const)("requires explicit %s on authenticated retry health", async (field) => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    const complete = health(111, "1.0.0", "sqlite", "/opt/lcm.mjs", "a".repeat(64));
    const incomplete = { ...complete };
    delete incomplete[field];
    f.seams.fetch = vi.fn()
      .mockResolvedValueOnce(response(health(111, "1.0.0", "sqlite")))
      .mockResolvedValueOnce(response(complete))
      .mockResolvedValueOnce(response({ totalConnections: 0 }))
      .mockResolvedValueOnce(response(incomplete)) as never;
    f.seams.isProcessAlive = vi.fn(() => true);
    const contention = new PrivateMutationLockContentionError("missing retry backend");
    let assertions = 0;

    await expect(restartDaemon(options(f, {
      _processStartTimeForTesting: () => "birth-111",
      _readPrivateMutationLockOwnerForTesting: () => ({
        version: 1,
        pid: 111,
        processStartTime: "birth-111",
        nonce: "4".repeat(32),
      }),
      _assertBackendPublication: () => {
        assertions += 1;
        if (assertions === 1) throw contention;
      },
    }))).rejects.toBe(contention);

    expect(assertions).toBe(1);
    expect(f.seams.killProcess).not.toHaveBeenCalled();
  });

  it.each([
    ["version", health(222, "wrong", "sqlite")],
    ["backend", health(222, "2.0.0", "postgresql")],
  ] as const)("declines outer-final convergence on public %s mismatch", async (_name, publicHealth) => {
    const f = fixture();
    const ensure = vi.fn(async (ensureOptions: EnsureDaemonOptions) => {
      writeFileSync(f.pidPath, "222", { mode: 0o600 });
      writeFileSync(f.tokenPath, "replacement-token", { mode: 0o600 });
      return { connected: true, port: ensureOptions.port, spawned: true, pid: 222 };
    });
    f.seams.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toBeUndefined();
      return response(publicHealth);
    }) as never;
    f.seams.isProcessAlive = vi.fn(() => true);
    let assertions = 0;
    const contention = new PrivateMutationLockContentionError("public replacement mismatch");

    await expect(restartDaemon(options(f, {
      _ensureDaemonOverride: ensure,
      _processStartTimeForTesting: () => "birth-222",
      _assertBackendPublication: () => {
        assertions += 1;
        if (assertions === 2) throw contention;
      },
    }))).rejects.toBe(contention);

    expect(f.seams.fetch).toHaveBeenCalledOnce();
    expect(assertions).toBe(2);
  });

  it.each(["token", "birth", "liveness"] as const)("declines current capture on %s drift", async (drift) => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    let birthReads = 0;
    let aliveReads = 0;
    f.seams.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/stats/pool")) {
        if (drift === "token") writeFileSync(f.tokenPath, "rotated-token", { mode: 0o600 });
        return response({ totalConnections: 0 });
      }
      return response(init?.headers === undefined
        ? health(111, "1.0.0", "sqlite")
        : health(111, "1.0.0", "sqlite", "/opt/lcm.mjs", "a".repeat(64)));
    }) as never;
    f.seams.isProcessAlive = vi.fn(() => drift !== "liveness" || aliveReads++ === 0);
    const contention = new PrivateMutationLockContentionError(`${drift} drift contention`);

    await expect(restartDaemon(options(f, {
      _processStartTimeForTesting: () => drift === "birth" && birthReads++ > 0
        ? "changed-birth"
        : "birth-111",
      _assertBackendPublication: () => { throw contention; },
    }))).rejects.toBe(contention);

    expect(f.seams.fetch).toHaveBeenCalledTimes(3);
    expect(f.seams.killProcess).not.toHaveBeenCalled();
  });

  it("rejects invalid capture scope before any identity I/O", async () => {
    const f = fixture();
    const contention = new PrivateMutationLockContentionError("invalid scope contention");
    const processBirth = vi.fn();
    const readOwner = vi.fn();

    await expect(restartDaemon({
      ...options(f),
      _hermeticTestSeams: {} as never,
      _processStartTimeForTesting: processBirth,
      _readPrivateMutationLockOwnerForTesting: readOwner,
      _assertBackendPublication: () => { throw contention; },
    })).rejects.toBe(contention);

    expect(processBirth).not.toHaveBeenCalled();
    expect(readOwner).not.toHaveBeenCalled();
  });

  it("rejects malformed test scope and conflicting valid scope/seams before I/O", async () => {
    const malformed = fixture();
    const conflict = fixture();
    const validScope = scopedOptions(conflict)._testScope!;
    const contention = new PrivateMutationLockContentionError("scope shape contention");

    await expect(restartDaemon({
      ...options(malformed),
      _hermeticTestSeams: undefined,
      _testScope: {} as never,
      _assertBackendPublication: () => { throw contention; },
    })).rejects.toBe(contention);
    await expect(restartDaemon({
      ...options(conflict),
      _testScope: validScope,
      _assertBackendPublication: () => { throw contention; },
    })).rejects.toBe(contention);

    expect(malformed.seams.fetch).not.toHaveBeenCalled();
    expect(conflict.seams.fetch).not.toHaveBeenCalled();
  });

  it("rejects exact-path drift for valid scoped and hermetic capture boundaries", async () => {
    const scoped = fixture();
    const scopedBase = scopedOptions(scoped);
    const hermetic = fixture();
    const contention = new PrivateMutationLockContentionError("path drift contention");

    await expect(restartDaemon({
      ...scopedBase,
      pidFilePath: join(scoped.root, "outside", "daemon.pid"),
      _assertBackendPublication: () => { throw contention; },
    })).rejects.toBe(contention);
    await expect(restartDaemon({
      ...options(hermetic),
      pidFilePath: join(hermetic.root, "outside", "daemon.pid"),
      _assertBackendPublication: () => { throw contention; },
    })).rejects.toBe(contention);

    expect(scoped.seams.fetch).not.toHaveBeenCalled();
    expect(hermetic.seams.fetch).not.toHaveBeenCalled();
  });

  it("rejects unscoped Vitest capture before injected process and network probes", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-950-unscoped-vitest-"));
    roots.push(root);
    const stateDir = join(root, ".lcm");
    mkdirSync(stateDir, { mode: 0o700 });
    const processBirth = vi.fn();
    const fetch = vi.fn();
    const contention = new PrivateMutationLockContentionError("unscoped Vitest contention");

    await expect(restartDaemon({
      port: 43_950,
      pidFilePath: join(stateDir, "daemon.pid"),
      spawnTimeoutMs: 100,
      expectedEntrypoint: "/opt/lcm.mjs",
      _fetchOverride: fetch,
      _processStartTimeForTesting: processBirth,
      _assertBackendPublication: () => { throw contention; },
    })).rejects.toBe(contention);

    expect(processBirth).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("captures canonical production state without relying on test ownership seams", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-950-production-capture-"));
    roots.push(root);
    const stateDir = join(root, ".lcm");
    mkdirSync(stateDir, { mode: 0o700 });
    const pidPath = join(stateDir, "daemon.pid");
    writeFileSync(pidPath, "111", { mode: 0o600 });
    writeFileSync(join(stateDir, "daemon.token"), "production-token", { mode: 0o600 });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/stats/pool")) return response({ totalConnections: 0 });
      return response(init?.headers === undefined
        ? health(111, "1.0.0", "sqlite")
        : health(111, "1.0.0", "sqlite", "/opt/lcm.mjs", "a".repeat(64)));
    });
    const contention = new PrivateMutationLockContentionError("production capture contention");
    const originalEntrypoint = process.argv[1];
    process.argv[1] = "/opt/test-runner.mjs";
    try {
      await expect(restartDaemon({
        port: 43_950,
        pidFilePath: pidPath,
        spawnTimeoutMs: 100,
        expectedEntrypoint: "/opt/lcm.mjs",
        _fetchOverride: fetch,
        _isProcessAliveOverride: () => true,
        _processStartTimeForTesting: () => "birth-111",
        _readPrivateMutationLockOwnerForTesting: () => ({
          version: 1,
          pid: 999,
          processStartTime: "birth-999",
          nonce: "6".repeat(32),
        }),
        _assertBackendPublication: () => { throw contention; },
      })).rejects.toBe(contention);
    } finally {
      process.argv[1] = originalEntrypoint;
    }

    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("treats a missing canonical production token as failed capture", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-950-production-token-"));
    roots.push(root);
    const stateDir = join(root, ".lcm");
    mkdirSync(stateDir, { mode: 0o700 });
    const pidPath = join(stateDir, "daemon.pid");
    writeFileSync(pidPath, "111", { mode: 0o600 });
    const fetch = vi.fn(async () => response(health(111, "1.0.0", "sqlite")));
    const contention = new PrivateMutationLockContentionError("missing production token");
    const originalEntrypoint = process.argv[1];
    process.argv[1] = "/opt/test-runner.mjs";
    try {
      await expect(restartDaemon({
        port: 43_950,
        pidFilePath: pidPath,
        spawnTimeoutMs: 100,
        expectedEntrypoint: "/opt/lcm.mjs",
        _fetchOverride: fetch,
        _isProcessAliveOverride: () => true,
        _processStartTimeForTesting: () => "birth-111",
        _assertBackendPublication: () => { throw contention; },
      })).rejects.toBe(contention);
    } finally {
      process.argv[1] = originalEntrypoint;
    }

    expect(fetch).toHaveBeenCalledOnce();
  });

  it("declines a noncanonical production PID path before capture I/O", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-950-production-path-"));
    roots.push(root);
    const pidPath = join(root, "daemon.pid");
    const fetch = vi.fn();
    const contention = new PrivateMutationLockContentionError("noncanonical path contention");
    const originalEntrypoint = process.argv[1];
    process.argv[1] = "/opt/test-runner.mjs";
    try {
      await expect(restartDaemon({
        port: 43_950,
        pidFilePath: pidPath,
        spawnTimeoutMs: 100,
        expectedEntrypoint: "/opt/lcm.mjs",
        _fetchOverride: fetch,
        _assertBackendPublication: () => { throw contention; },
      })).rejects.toBe(contention);
    } finally {
      process.argv[1] = originalEntrypoint;
    }

    expect(fetch).not.toHaveBeenCalled();
  });

  it("selects production process and owner probes only for canonical unscoped state", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-950-production-default-probes-"));
    roots.push(root);
    const stateDir = join(root, ".lcm");
    mkdirSync(stateDir, { mode: 0o700 });
    const contention = new PrivateMutationLockContentionError("production default probes");
    const originalEntrypoint = process.argv[1];
    process.argv[1] = "/opt/test-runner.mjs";
    try {
      await expect(restartDaemon({
        port: 43_950,
        pidFilePath: join(stateDir, "daemon.pid"),
        spawnTimeoutMs: 100,
        expectedEntrypoint: "/opt/lcm.mjs",
        _assertBackendPublication: () => { throw contention; },
      })).rejects.toBe(contention);
    } finally {
      process.argv[1] = originalEntrypoint;
    }
  });

  it.each([
    ["expired birth budget", [0, 2_000]],
    ["sub-millisecond birth budget", [0, 1_998]],
    ["expired public-health budget", [0, 0, 2_000]],
  ] as const)("declines capture with %s", async (_name, clockValues) => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    f.seams.isProcessAlive = vi.fn(() => true);
    let clockIndex = 0;
    const contention = new PrivateMutationLockContentionError("capture budget contention");

    await expect(restartDaemon(options(f, {
      _monotonicNowOverride: () => clockValues[Math.min(clockIndex++, clockValues.length - 1)]!,
      _processStartTimeForTesting: () => "birth-111",
      _assertBackendPublication: () => { throw contention; },
    }))).rejects.toBe(contention);

    expect(f.seams.fetch).not.toHaveBeenCalled();
  });

  it("treats unsafe scoped token state as failed capture", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    const external = join(f.root, "external-token");
    writeFileSync(external, "external", { mode: 0o600 });
    f.seams.isProcessAlive = vi.fn(() => true);
    f.seams.fetch = vi.fn(async () => {
      unlinkSync(f.tokenPath);
      symlinkSync(external, f.tokenPath);
      return response(health(111, "1.0.0", "sqlite"));
    }) as never;
    const contention = new PrivateMutationLockContentionError("unsafe token contention");

    await expect(restartDaemon({
      ...options(f),
      _processStartTimeForTesting: () => "birth-111",
      _assertBackendPublication: () => { throw contention; },
    })).rejects.toBe(contention);

    expect(f.seams.fetch).toHaveBeenCalledOnce();
  });

  it("uses the hermetic default-null owner probe to refuse retry", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    f.seams.isProcessAlive = vi.fn(() => true);
    f.seams.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/stats/pool")) return response({ totalConnections: 0 });
      return response(init?.headers === undefined
        ? health(111, "1.0.0", "sqlite")
        : health(111, "1.0.0", "sqlite", "/opt/lcm.mjs", "a".repeat(64)));
    }) as never;
    const contention = new PrivateMutationLockContentionError("default owner probe contention");

    await expect(restartDaemon(options(f, {
      _processStartTimeForTesting: () => "birth-111",
      _assertBackendPublication: () => { throw contention; },
    }))).rejects.toBe(contention);

    expect(f.seams.fetch).toHaveBeenCalledTimes(3);
  });

  it("does not disclose a token that rotates between pinning and authentication", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    f.seams.isProcessAlive = vi.fn(() => true);
    f.seams.fetch = vi.fn(async () => response(health(111, "1.0.0", "sqlite"))) as never;
    publicationFsFault.tokenPath = f.tokenPath;
    publicationFsFault.rotateTokenOnSecondOpen = true;
    const contention = new PrivateMutationLockContentionError("pre-auth token rotation");

    await expect(restartDaemon(options(f, {
      _processStartTimeForTesting: () => "birth-111",
      _assertBackendPublication: () => { throw contention; },
    }))).rejects.toBe(contention);

    expect(f.seams.fetch).toHaveBeenCalledOnce();
  });

  it("does not probe process birth after PID revalidation observes abort", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    f.seams.isProcessAlive = vi.fn(() => true);
    f.seams.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/stats/pool")) return response({ totalConnections: 0 });
      return response(init?.headers === undefined
        ? health(111, "1.0.0", "sqlite")
        : health(111, "1.0.0", "sqlite", "/opt/lcm.mjs", "a".repeat(64)));
    }) as never;
    const controller = new AbortController();
    publicationFsFault.pidPath = f.pidPath;
    publicationFsFault.abortAfterPidOpen = controller;
    const processBirth = vi.fn(() => "birth-111");
    const contention = new PrivateMutationLockContentionError("post-PID abort");

    await expect(restartDaemon(options(f, {
      _abortSignal: controller.signal,
      _processStartTimeForTesting: processBirth,
      _assertBackendPublication: () => { throw contention; },
    }))).rejects.toBe(contention);

    expect(processBirth).toHaveBeenCalledOnce();
  });

  it("declines replacement capture before I/O when installed identity is empty", async () => {
    const f = fixture();
    const ensure = vi.fn(async (ensureOptions: EnsureDaemonOptions) => {
      writeFileSync(f.pidPath, "222", { mode: 0o600 });
      writeFileSync(f.tokenPath, "replacement-token", { mode: 0o600 });
      return { connected: true, port: ensureOptions.port, spawned: true, pid: 222 };
    });
    let assertions = 0;
    const contention = new PrivateMutationLockContentionError("empty replacement identity");

    await expect(restartDaemon(options(f, {
      expectedRuntimeDigest: "",
      _ensureDaemonOverride: ensure,
      _assertBackendPublication: () => {
        assertions += 1;
        if (assertions === 2) throw contention;
      },
    }))).rejects.toBe(contention);

    expect(f.seams.fetch).not.toHaveBeenCalled();
  });

  it("uses the packaged entrypoint seam when no explicit entrypoint is supplied", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    f.seams.isProcessAlive = vi.fn(() => true);
    f.seams.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/stats/pool")) return response({ totalConnections: 0 });
      return response(init?.headers === undefined
        ? health(111, "1.0.0", "sqlite")
        : health(111, "1.0.0", "sqlite", "/packaged/lcm.mjs", "a".repeat(64)));
    }) as never;
    const contention = new PrivateMutationLockContentionError("packaged entrypoint contention");

    await expect(restartDaemon(options(f, {
      expectedEntrypoint: undefined,
      _packagedEntrypointOverride: "/packaged/lcm.mjs",
      _processStartTimeForTesting: () => "birth-111",
      _readPrivateMutationLockOwnerForTesting: () => ({
        version: 1,
        pid: 999,
        processStartTime: "birth-999",
        nonce: "8".repeat(32),
      }),
      _assertBackendPublication: () => { throw contention; },
    }))).rejects.toBe(contention);

    expect(f.seams.fetch).toHaveBeenCalledTimes(3);
  });

  it("declines source-runtime capture when no entrypoint authority exists", async () => {
    const f = fixture();
    const contention = new PrivateMutationLockContentionError("missing entrypoint authority");

    await expect(restartDaemon(options(f, {
      expectedEntrypoint: undefined,
      _packagedEntrypointOverride: undefined,
      _assertBackendPublication: () => { throw contention; },
    }))).rejects.toBe(contention);

    expect(f.seams.fetch).not.toHaveBeenCalled();
  });

  it("declines when the process-birth probe throws", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    f.seams.isProcessAlive = vi.fn(() => true);
    const contention = new PrivateMutationLockContentionError("throwing birth probe");

    await expect(restartDaemon(options(f, {
      _processStartTimeForTesting: () => { throw new Error("birth unavailable"); },
      _assertBackendPublication: () => { throw contention; },
    }))).rejects.toBe(contention);

    expect(f.seams.fetch).not.toHaveBeenCalled();
  });

  it("preserves first contention when capture starts already aborted", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    const contention = new PrivateMutationLockContentionError("aborted capture contention");

    await expect(restartDaemon(options(f, {
      _abortSignal: controller.signal,
      _processStartTimeForTesting: vi.fn(),
      _readPrivateMutationLockOwnerForTesting: vi.fn(),
      _assertBackendPublication: () => { throw contention; },
    }))).rejects.toBe(contention);

    expect(f.seams.fetch).not.toHaveBeenCalled();
    expect(f.seams.isProcessAlive).not.toHaveBeenCalled();
  });

  it.each(["header", "body"] as const)("preserves contention on mid-capture %s abort", async (phase) => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    const controller = new AbortController();
    f.seams.fetch = vi.fn(async () => {
      queueMicrotask(() => controller.abort());
      if (phase === "header") return await new Promise<never>(() => undefined);
      return {
        ok: true,
        status: 200,
        json: async () => await new Promise<never>(() => undefined),
      } as Response;
    }) as never;
    f.seams.isProcessAlive = vi.fn(() => true);
    const contention = new PrivateMutationLockContentionError(`${phase} capture abort`);

    await expect(restartDaemon(options(f, {
      _abortSignal: controller.signal,
      _processStartTimeForTesting: () => "birth-111",
      _readPrivateMutationLockOwnerForTesting: vi.fn(),
      _assertBackendPublication: () => { throw contention; },
    }))).rejects.toBe(contention);

    expect(f.seams.killProcess).not.toHaveBeenCalled();
  });

  it("preserves contention when abort lands during retry authentication", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    const controller = new AbortController();
    const complete = health(111, "1.0.0", "sqlite", "/opt/lcm.mjs", "a".repeat(64));
    f.seams.fetch = vi.fn()
      .mockResolvedValueOnce(response(health(111, "1.0.0", "sqlite")))
      .mockResolvedValueOnce(response(complete))
      .mockResolvedValueOnce(response({ totalConnections: 0 }))
      .mockImplementationOnce(async () => {
        queueMicrotask(() => controller.abort());
        return await new Promise<never>(() => undefined);
      }) as never;
    f.seams.isProcessAlive = vi.fn(() => true);
    const contention = new PrivateMutationLockContentionError("retry authentication abort");

    await expect(restartDaemon(options(f, {
      _abortSignal: controller.signal,
      _processStartTimeForTesting: () => "birth-111",
      _readPrivateMutationLockOwnerForTesting: () => ({
        version: 1,
        pid: 111,
        processStartTime: "birth-111",
        nonce: "5".repeat(32),
      }),
      _assertBackendPublication: () => { throw contention; },
    }))).rejects.toBe(contention);

    expect(f.seams.killProcess).not.toHaveBeenCalled();
  });

  it("preserves contention when abort lands during authenticated access", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    const controller = new AbortController();
    const complete = health(111, "1.0.0", "sqlite", "/opt/lcm.mjs", "a".repeat(64));
    f.seams.fetch = vi.fn()
      .mockResolvedValueOnce(response(health(111, "1.0.0", "sqlite")))
      .mockResolvedValueOnce(response(complete))
      .mockImplementationOnce(async () => {
        queueMicrotask(() => controller.abort());
        return await new Promise<never>(() => undefined);
      }) as never;
    f.seams.isProcessAlive = vi.fn(() => true);
    const contention = new PrivateMutationLockContentionError("access abort contention");

    await expect(restartDaemon(options(f, {
      _abortSignal: controller.signal,
      _processStartTimeForTesting: () => "birth-111",
      _assertBackendPublication: () => { throw contention; },
    }))).rejects.toBe(contention);

    expect(f.seams.killProcess).not.toHaveBeenCalled();
  });

  it("preserves contention when abort lands during convergence sleep", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    const controller = new AbortController();
    f.seams.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/stats/pool")) return response({ totalConnections: 0 });
      return response(init?.headers === undefined
        ? health(111, "1.0.0", "sqlite")
        : health(111, "1.0.0", "sqlite", "/opt/lcm.mjs", "a".repeat(64)));
    }) as never;
    f.seams.isProcessAlive = vi.fn(() => true);
    f.seams.sleep = vi.fn(async () => {
      queueMicrotask(() => controller.abort());
      return await new Promise<never>(() => undefined);
    });
    const contention = new PrivateMutationLockContentionError("sleep abort contention");

    await expect(restartDaemon(options(f, {
      _abortSignal: controller.signal,
      _processStartTimeForTesting: () => "birth-111",
      _readPrivateMutationLockOwnerForTesting: () => ({
        version: 1,
        pid: 111,
        processStartTime: "birth-111",
        nonce: "7".repeat(32),
      }),
      _assertBackendPublication: () => { throw contention; },
    }))).rejects.toBe(contention);

    expect(f.seams.killProcess).not.toHaveBeenCalled();
  });

  it.each(["header", "body"] as const)("preserves contention when capture %s times out", async (phase) => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      writeFileSync(f.pidPath, "111", { mode: 0o600 });
      writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
      f.seams.fetch = vi.fn(async () => phase === "header"
        ? await new Promise<never>(() => undefined)
        : {
            ok: true,
            status: 200,
            json: async () => await new Promise<never>(() => undefined),
          } as Response) as never;
      f.seams.isProcessAlive = vi.fn(() => true);
      const contention = new PrivateMutationLockContentionError(`${phase} timeout contention`);
      const pending = restartDaemon(options(f, {
        _processStartTimeForTesting: () => "birth-111",
        _assertBackendPublication: () => { throw contention; },
      }));
      let observed: unknown;
      const handled = pending.then(() => undefined, (error: unknown) => { observed = error; });

      await vi.advanceTimersByTimeAsync(2_000);
      await handled;

      expect(observed).toBe(contention);
      expect(f.seams.killProcess).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not trust a connected override result as outer-final publication evidence", async () => {
    const f = fixture();
    const ensure = vi.fn(async (ensureOptions: EnsureDaemonOptions) => ({
      connected: true,
      port: ensureOptions.port,
      spawned: true,
      pid: 222,
    }));
    let assertions = 0;
    const contention = new PrivateMutationLockContentionError("override result is not evidence");

    await expect(restartDaemon(options(f, {
      _ensureDaemonOverride: ensure,
      _processStartTimeForTesting: vi.fn(),
      _readPrivateMutationLockOwnerForTesting: vi.fn(),
      _assertBackendPublication: () => {
        assertions += 1;
        if (assertions === 2) throw contention;
      },
    }))).rejects.toBe(contention);

    expect(ensure).toHaveBeenCalledOnce();
    expect(f.seams.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["malformed", "not-a-pid"],
    ["unsafe", "9007199254740992"],
  ] as const)("declines outer initial convergence with %s owned PID", async (_name, pid) => {
    const f = fixture();
    if (pid !== undefined) writeFileSync(f.pidPath, pid, { mode: 0o600 });
    writeFileSync(f.tokenPath, "token", { mode: 0o600 });
    const contention = new PrivateMutationLockContentionError("invalid PID contention");

    await expect(restartDaemon(options(f, {
      _processStartTimeForTesting: vi.fn(),
      _readPrivateMutationLockOwnerForTesting: vi.fn(),
      _assertBackendPublication: () => { throw contention; },
    }))).rejects.toBe(contention);

    expect(f.seams.fetch).not.toHaveBeenCalled();
    expect(f.seams.isProcessAlive).not.toHaveBeenCalled();
  });

  it.each([
    ["version", health(222, "wrong", "sqlite", "/opt/lcm.mjs", "b".repeat(64))],
    ["backend", health(222, "2.0.0", "postgresql", "/opt/lcm.mjs", "b".repeat(64))],
    ["entrypoint", health(222, "2.0.0", "sqlite", "/foreign.mjs", "b".repeat(64))],
    ["digest", health(222, "2.0.0", "sqlite", "/opt/lcm.mjs", "c".repeat(64))],
  ] as const)("declines outer-final convergence on authenticated %s mismatch", async (_name, authenticated) => {
    const f = fixture();
    const ensure = vi.fn(async (ensureOptions: EnsureDaemonOptions) => {
      writeFileSync(f.pidPath, "222", { mode: 0o600 });
      writeFileSync(f.tokenPath, "replacement-token", { mode: 0o600 });
      return { connected: true, port: ensureOptions.port, spawned: true, pid: 222 };
    });
    f.seams.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/stats/pool")) return response({ totalConnections: 0 });
      return response(init?.headers === undefined
        ? health(222, "2.0.0", "sqlite")
        : authenticated);
    }) as never;
    f.seams.isProcessAlive = vi.fn(() => true);
    let assertions = 0;
    const contention = new PrivateMutationLockContentionError("replacement identity mismatch");

    await expect(restartDaemon(options(f, {
      _ensureDaemonOverride: ensure,
      _processStartTimeForTesting: () => "birth-222",
      _readPrivateMutationLockOwnerForTesting: vi.fn(),
      _assertBackendPublication: () => {
        assertions += 1;
        if (assertions === 2) throw contention;
      },
    }))).rejects.toBe(contention);

    expect(assertions).toBe(2);
    expect(ensure).toHaveBeenCalledOnce();
    expect(f.seams.killProcess).not.toHaveBeenCalled();
  });

  it.each([
    ["mismatching", "333", 222],
    ["malformed", "not-a-pid", 222],
    ["unsafe", "9007199254740992", 222],
    ["missing manager", undefined, undefined],
  ] as const)("declines nested initial convergence with %s PID authority", async (_name, pidState, managerPid) => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/stats/pool")) return response({ totalConnections: 0 });
      return response(init?.headers === undefined
        ? health(111, "1.0.0", "sqlite")
        : health(111, "1.0.0", "sqlite", "/opt/lcm.mjs", "b".repeat(64)));
    });
    f.seams.fetch = fetch as never;
    f.seams.isProcessAlive = vi.fn(() => true);
    const probe = vi.fn(async (spec: SupervisorSpec): Promise<SupervisorObservation> => ({
      kind: "registered-running-valid",
      name: spec.name,
      scopeDigest: spec.scopeDigest,
      nonce: spec.nonce,
      managerPid: 111,
    }));
    const stopAndStart = vi.fn(async (spec: SupervisorSpec) => {
      rmSync(f.pidPath, { force: true });
      if (pidState !== undefined) writeFileSync(f.pidPath, pidState, { mode: 0o600 });
      writeFileSync(f.tokenPath, "replacement-token", { mode: 0o600 });
      return {
        kind: spec.kind,
        name: spec.name,
        scopeDigest: spec.scopeDigest,
        port: spec.port,
        nonce: spec.nonce,
        ...(managerPid === undefined ? {} : { managerPid }),
      };
    });
    const supervisor: Supervisor = {
      probe,
      start: vi.fn(),
      stopAndStart,
      stopAndAwaitAbsent: vi.fn(),
    };
    let assertions = 0;
    const contention = new PrivateMutationLockContentionError("nested authority contention");
    const injectedEnsure = vi.fn(async (ensureOptions: EnsureDaemonOptions) => {
      const wrap = ensureOptions._withInitialPublicationAdmissionRetry
        ?? (async <T>(step: () => T | Promise<T>) => await step());
      await wrap(() => ensureOptions._assertBackendPublication?.(f.root, "sqlite"));
      return { connected: true, port: ensureOptions.port, spawned: true, pid: managerPid };
    });

    await expect(restartDaemon(options(f, {
      enforceUserManagerParent: true,
      spawnTimeoutMs: 1_000,
      _supervisorOverride: supervisor,
      _ensureDaemonOverride: injectedEnsure,
      _listeningPortsOverride: () => [43_950],
      _processStartTimeForTesting: vi.fn(),
      _readPrivateMutationLockOwnerForTesting: vi.fn(),
      _assertBackendPublication: () => {
        assertions += 1;
        if (assertions === 2) throw contention;
      },
    }))).rejects.toBe(contention);

    expect(stopAndStart).toHaveBeenCalledOnce();
    expect(assertions).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("converges a real nested ensure initial assertion from manager PID while PID state is absent", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    let phase: "current" | "replacement" = "current";
    let assertions = 0;
    let now = 0;
    let authenticatedReplacementResponses = 0;
    let chargedNestedCapture = false;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/stats/pool")) return response({ totalConnections: 0 });
      if (phase === "current") {
        return response(init?.headers === undefined
          ? health(111, "1.0.0", "postgresql")
          : health(111, "1.0.0", "postgresql", "/opt/lcm.mjs", "b".repeat(64)));
      }
      if (init?.headers === undefined && !chargedNestedCapture) {
        chargedNestedCapture = true;
        now += 1_900;
      }
      if (init?.headers !== undefined && ++authenticatedReplacementResponses === 1) {
        writeFileSync(f.pidPath, "222", { mode: 0o600 });
      }
      return response(init?.headers === undefined
        ? health(222, "2.0.0", "sqlite")
        : health(222, "2.0.0", "sqlite", "/opt/lcm.mjs", "b".repeat(64)));
    });
    f.seams.fetch = fetch as never;
    f.seams.isProcessAlive = vi.fn(() => true);
    f.seams.sleep = vi.fn(async (delayMs) => { now += delayMs; });
    const probe = vi.fn(async (spec: SupervisorSpec): Promise<SupervisorObservation> => ({
      kind: "registered-running-valid",
      name: spec.name,
      scopeDigest: spec.scopeDigest,
      nonce: spec.nonce,
      managerPid: phase === "current" ? 111 : 222,
    }));
    const stopAndStart = vi.fn(async (spec: SupervisorSpec) => {
      phase = "replacement";
      unlinkSync(f.pidPath);
      writeFileSync(f.tokenPath, "replacement-token", { mode: 0o600 });
      return {
        kind: spec.kind,
        name: spec.name,
        scopeDigest: spec.scopeDigest,
        port: spec.port,
        nonce: spec.nonce,
        managerPid: 222,
      };
    });
    const supervisor: Supervisor = {
      probe,
      start: vi.fn(),
      stopAndStart,
      stopAndAwaitAbsent: vi.fn(),
    };
    const nestedContention = new PrivateMutationLockContentionError("nested replacement sweep contention");
    const childFinalContention = new PrivateMutationLockContentionError("child final sweep contention");
    const callerWrap = vi.fn(async <T>(step: () => T | Promise<T>) => await step());

    const result = await restartDaemon(options(f, {
      enforceUserManagerParent: true,
      spawnTimeoutMs: 1_000,
      _supervisorOverride: supervisor,
      _withPublicationAdmissionRetry: callerWrap,
      _monotonicNowOverride: () => now,
      _listeningPortsOverride: () => [43_950],
      _processStartTimeForTesting: (pid) => `birth-${pid}`,
      _readPrivateMutationLockOwnerForTesting: () => ({
        version: 1,
        pid: 222,
        processStartTime: "birth-222",
        nonce: "c".repeat(32),
      }),
      _assertBackendPublication: () => {
        assertions += 1;
        if (assertions === 2) throw nestedContention;
        if (assertions === 4) throw childFinalContention;
      },
    }));

    expect(result).toMatchObject({ connected: true, spawned: false, restarted: true, pid: 222 });
    expect(assertions).toBe(6);
    expect(stopAndStart).toHaveBeenCalledOnce();
    expect(callerWrap).not.toHaveBeenCalled();
    expect(now).toBe(2_000);
  });

  it("uses the caller wrapper only for a managed nested final without child evidence", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    let phase: "current" | "replacement" = "current";
    let assertions = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/stats/pool")) return response({ totalConnections: 0 });
      return response(phase === "current"
        ? init?.headers === undefined
          ? health(111, "1.0.0", "sqlite")
          : health(111, "1.0.0", "sqlite", "/opt/lcm.mjs", "b".repeat(64))
        : init?.headers === undefined
          ? health(222, "2.0.0", "sqlite")
          : health(222, "2.0.0", "sqlite", "/opt/lcm.mjs", "b".repeat(64)));
    });
    f.seams.fetch = fetch as never;
    f.seams.isProcessAlive = vi.fn(() => true);
    const probe = vi.fn(async (spec: SupervisorSpec): Promise<SupervisorObservation> => ({
      kind: "registered-running-valid",
      name: spec.name,
      scopeDigest: spec.scopeDigest,
      nonce: spec.nonce,
      managerPid: phase === "current" ? 111 : 222,
    }));
    const stopAndStart = vi.fn(async (spec: SupervisorSpec) => {
      phase = "replacement";
      writeFileSync(f.pidPath, "222", { mode: 0o600 });
      writeFileSync(f.tokenPath, "replacement-token", { mode: 0o600 });
      return {
        kind: spec.kind,
        name: spec.name,
        scopeDigest: spec.scopeDigest,
        port: spec.port,
        nonce: spec.nonce,
        managerPid: 222,
      };
    });
    const supervisor: Supervisor = {
      probe,
      start: vi.fn(),
      stopAndStart,
      stopAndAwaitAbsent: vi.fn(),
    };
    const callerWrap = vi.fn(async <T>(step: () => T | Promise<T>) => {
      expect(assertions).toBe(2);
      return await step();
    });
    const injectedEnsure = vi.fn(async (ensureOptions: EnsureDaemonOptions) => await ensureDaemon({
      ...ensureOptions,
      _skipHealthWait: true,
    }));

    const result = await restartDaemon(options(f, {
      enforceUserManagerParent: true,
      spawnTimeoutMs: 1_000,
      _supervisorOverride: supervisor,
      _ensureDaemonOverride: injectedEnsure,
      _withPublicationAdmissionRetry: callerWrap,
      _listeningPortsOverride: () => [43_950],
      _assertBackendPublication: () => { assertions += 1; },
    }));

    expect(result).toMatchObject({ connected: true, spawned: false, restarted: true, pid: 222 });
    expect(assertions).toBe(4);
    expect(callerWrap).toHaveBeenCalledOnce();
    expect(stopAndStart).toHaveBeenCalledOnce();
  });

  it("gives current and replacement identities independent active retry budgets", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    let now = 0;
    let assertions = 0;
    let alive = true;
    let replacement = false;
    let chargedCurrentCapture = false;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/stats/pool")) return response({ totalConnections: 0 });
      if (!replacement) {
        if (init?.headers === undefined && !chargedCurrentCapture) {
          chargedCurrentCapture = true;
          now += 1_900;
        }
        return response(init?.headers === undefined
          ? health(111, "1.0.0", "postgresql")
          : health(111, "1.0.0", "postgresql", "/opt/lcm.mjs", "a".repeat(64)));
      }
      return response(init?.headers === undefined
        ? health(222, "2.0.0", "sqlite")
        : health(222, "2.0.0", "sqlite", "/opt/lcm.mjs", "b".repeat(64)));
    });
    f.seams.fetch = fetch as never;
    f.seams.isProcessAlive = vi.fn((pid) => pid === 222 || (pid === 111 && alive));
    f.seams.killProcess = vi.fn(() => { alive = false; });
    f.seams.sleep = vi.fn(async (delayMs) => { now += delayMs; });
    const ensure = vi.fn(async (ensureOptions: EnsureDaemonOptions) => {
      replacement = true;
      now += 10_000;
      writeFileSync(f.pidPath, "222", { mode: 0o600 });
      writeFileSync(f.tokenPath, "replacement-token", { mode: 0o600 });
      return { connected: true, port: ensureOptions.port, spawned: true, pid: 222 };
    });
    const currentContention = new PrivateMutationLockContentionError("current budget contention");
    const replacementContention = new PrivateMutationLockContentionError("replacement budget contention");

    await expect(restartDaemon(options(f, {
      spawnTimeoutMs: 20_000,
      _monotonicNowOverride: () => now,
      _ensureDaemonOverride: ensure,
      _processStartTimeForTesting: (pid) => `birth-${pid}`,
      _readPrivateMutationLockOwnerForTesting: () => ({
        version: 1,
        pid: replacement ? 222 : 111,
        processStartTime: replacement ? "birth-222" : "birth-111",
        nonce: "e".repeat(32),
      }),
      _assertBackendPublication: () => {
        assertions += 1;
        if (assertions === 1) throw currentContention;
        if (assertions === 3) throw replacementContention;
      },
    }))).resolves.toMatchObject({ restarted: true, pid: 222 });

    expect(assertions).toBe(4);
    expect(ensure).toHaveBeenCalledOnce();
    expect(now).toBe(12_500);
  });

  it("shares replacement active time and preserves its first contention", async () => {
    const f = fixture();
    writeFileSync(f.pidPath, "111", { mode: 0o600 });
    writeFileSync(f.tokenPath, "current-token", { mode: 0o600 });
    let phase: "current" | "replacement" = "current";
    let now = 0;
    let assertions = 0;
    let chargedNestedCapture = false;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/stats/pool")) return response({ totalConnections: 0 });
      if (phase === "current") {
        return response(init?.headers === undefined
          ? health(111, "1.0.0", "sqlite")
          : health(111, "1.0.0", "sqlite", "/opt/lcm.mjs", "b".repeat(64)));
      }
      if (init?.headers === undefined && !chargedNestedCapture) {
        chargedNestedCapture = true;
        now += 1_900;
      }
      return response(init?.headers === undefined
        ? health(222, "2.0.0", "sqlite")
        : health(222, "2.0.0", "sqlite", "/opt/lcm.mjs", "b".repeat(64)));
    });
    f.seams.fetch = fetch as never;
    f.seams.isProcessAlive = vi.fn(() => true);
    f.seams.sleep = vi.fn(async (delayMs) => { now += delayMs; });
    const probe = vi.fn(async (spec: SupervisorSpec): Promise<SupervisorObservation> => ({
      kind: "registered-running-valid",
      name: spec.name,
      scopeDigest: spec.scopeDigest,
      nonce: spec.nonce,
      managerPid: 111,
    }));
    const stopAndStart = vi.fn(async (spec: SupervisorSpec) => {
      phase = "replacement";
      unlinkSync(f.pidPath);
      writeFileSync(f.tokenPath, "replacement-token", { mode: 0o600 });
      return {
        kind: spec.kind,
        name: spec.name,
        scopeDigest: spec.scopeDigest,
        port: spec.port,
        nonce: spec.nonce,
        managerPid: 222,
      };
    });
    const supervisor: Supervisor = {
      probe,
      start: vi.fn(),
      stopAndStart,
      stopAndAwaitAbsent: vi.fn(),
    };
    const nestedContention = new PrivateMutationLockContentionError("first replacement contention");
    const finalContention = new PrivateMutationLockContentionError("later final contention");
    const injectedEnsure = vi.fn(async (ensureOptions: EnsureDaemonOptions) => {
      const wrap = ensureOptions._withInitialPublicationAdmissionRetry!;
      await wrap(() => ensureOptions._assertBackendPublication?.(f.root, "sqlite"));
      now += 10_000;
      writeFileSync(f.pidPath, "222", { mode: 0o600 });
      return { connected: true, port: ensureOptions.port, spawned: true, pid: 222 };
    });

    await expect(restartDaemon(options(f, {
      enforceUserManagerParent: true,
      spawnTimeoutMs: 10_000,
      _supervisorOverride: supervisor,
      _ensureDaemonOverride: injectedEnsure,
      _monotonicNowOverride: () => now,
      _listeningPortsOverride: () => [43_950],
      _processStartTimeForTesting: () => "birth-222",
      _readPrivateMutationLockOwnerForTesting: () => ({
        version: 1,
        pid: 222,
        processStartTime: "birth-222",
        nonce: "f".repeat(32),
      }),
      _assertBackendPublication: () => {
        assertions += 1;
        if (assertions === 2) throw nestedContention;
        if (assertions === 4) throw finalContention;
      },
    }))).rejects.toBe(nestedContention);

    expect(assertions).toBe(4);
    expect(stopAndStart).toHaveBeenCalledOnce();
    expect(injectedEnsure).toHaveBeenCalledOnce();
    expect(now).toBe(12_000);
  });
});
