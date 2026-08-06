import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertLifecycleScopeOwnsCurrentCleanupRoot,
  createDaemonLifecycleTestScope,
  DAEMON_TEST_ENTRYPOINT_OPTION,
  DAEMON_TEST_OWNER_OPTION,
  isDaemonLifecycleHermeticTestSeams,
  isDaemonLifecycleTestIdentity,
  isDaemonLifecycleTestScope,
  isCanonicalLifecycleTestDirectory,
  isCanonicalLifecycleTestRegularFile,
  isVitestWorkerEntrypoint,
  lifecycleScopeOwnsPath,
  lifecycleScopeUnitName,
  type DaemonLifecycleTestDependencies,
  type DaemonLifecycleHermeticTestSeams,
  type DaemonLifecycleTestScope,
} from "../../src/daemon/lifecycle-scope.js";
import {
  __lifecycleTestUtils,
  ensureDaemon,
  restartDaemon,
} from "../../src/daemon/lifecycle.js";
import { ensureAuthToken } from "../../src/daemon/auth.js";
import { createDaemon } from "../../src/daemon/server.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { MANAGED_CREDENTIAL_NAMES } from "../../src/daemon/managed-credentials.js";
import { RUNTIME_DIGEST } from "../../src/daemon/version.js";

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
  supervisor: {
    probe: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stopAndStart: ReturnType<typeof vi.fn>;
    stopAndAwaitAbsent: ReturnType<typeof vi.fn>;
  };
};

const roots: string[] = [];
function shouldCollectSystemdBarrier(
  command: string,
  args: readonly string[],
  status: number | null | undefined,
  barrierDir: string | undefined,
): boolean {
  return command === "systemd-run"
    && args.some(arg => arg.startsWith("--unit="))
    && status === 0
    && barrierDir !== undefined;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("systemd manager command-vector harness", () => {
  it("collects readiness only after a successful systemd-run mutation", () => {
    const unit = "lcm-daemon-0123456789abcdef0123.service";
    const probeArgs = [
      "--user",
      "show",
      "--no-pager",
      "--property=LoadState,ActiveState,SubState,MainPID,Environment,ExecMainStartTimestamp,FragmentPath",
      unit,
    ] as const;
    const startArgs = ["--user", "--no-block", `--unit=${unit}`, "/usr/bin/env", "-i"] as const;
    expect(shouldCollectSystemdBarrier("systemctl", probeArgs, 0, "/tmp/barrier")).toBe(false);
    expect(shouldCollectSystemdBarrier("systemd-run", startArgs, 0, "/tmp/barrier")).toBe(true);
    expect(shouldCollectSystemdBarrier("systemd-run", startArgs, 1, "/tmp/barrier")).toBe(false);
    expect(shouldCollectSystemdBarrier("systemd-run", startArgs, 0, undefined)).toBe(false);
    expect(shouldCollectSystemdBarrier("systemd-run", [
      "--user",
    ], 0, "/tmp/barrier")).toBe(false);
  });
});

function createFixture(
  ownerId: string,
  overrides: Partial<DaemonLifecycleTestDependencies> = {},
): ScopeFixture {
  const root = mkdtempSync(join(tmpdir(), `lcm-lifecycle-scope-${ownerId}-`));
  roots.push(root);
  const homeDir = join(root, "home");
  const runtimeDir = join(homeDir, "runtime");
  const stateDir = join(homeDir, ".lcm");
  const credentialDir = join(homeDir, "credentials");
  const entrypoint = join(runtimeDir, "owned-daemon.mjs");
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(credentialDir, { recursive: true });
  chmodSync(stateDir, 0o700);
  chmodSync(credentialDir, 0o700);
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
  let registered = false;
  let managerPid = 42_424;
  const supervisor = {
    probe: vi.fn(async (spec: { scopeDigest: string; nonce: string; name: string }) => registered
      ? {
          kind: "registered-running-valid" as const,
          managerPid,
          scopeDigest: spec.scopeDigest,
          nonce: spec.nonce,
          name: spec.name,
        }
      : { kind: "absent" as const, name: spec.name }),
    start: vi.fn(async (spec: { scopeDigest: string; nonce: string; name: string; stateRoot: string }) => {
      const result = runSystemd("systemd-run", [
        "--user",
        "--no-block",
        "--quiet",
        `--unit=${spec.name}`,
        `--setenv=HOME=${scope.homeDir}`,
        `--setenv=LCM_DAEMON_OWNER_ID=${scope.ownerId}`,
        `--setenv=USERPROFILE=${scope.homeDir}`,
        `--setenv=XDG_RUNTIME_DIR=${scope.runtimeDir}`,
        scope.entrypoint,
        "daemon",
        "start",
        "--foreground",
        DAEMON_TEST_OWNER_OPTION,
        scope.ownerId,
        DAEMON_TEST_ENTRYPOINT_OPTION,
        scope.entrypoint,
      ], {
        encoding: "utf-8",
        env: {
          HOME: scope.homeDir,
          USERPROFILE: scope.homeDir,
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
          DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
          LCM_DAEMON_OWNER_ID: scope.ownerId,
        },
        timeout: 25,
      });
      if (result.status !== 0) throw new Error("manager start failed");
      registered = true;
      writeFileSync(join(spec.stateRoot, "daemon.pid"), String(managerPid));
      return {
        kind: "systemd-user" as const,
        name: spec.name,
        scopeDigest: spec.scopeDigest,
        port: 48_321,
        nonce: spec.nonce,
        managerPid,
      };
    }),
    stopAndStart: vi.fn(async (spec: { scopeDigest: string; nonce: string; name: string; stateRoot: string }) => {
      registered = true;
      writeFileSync(join(spec.stateRoot, "daemon.pid"), String(managerPid));
      return {
        kind: "systemd-user" as const,
        name: spec.name,
        scopeDigest: spec.scopeDigest,
        port: 48_321,
        nonce: spec.nonce,
        managerPid,
      };
    }),
    stopAndAwaitAbsent: vi.fn(async (spec: { name: string }) => {
      registered = false;
      await stopUnit(spec.name);
    }),
  };
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
    supervisor,
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
    _platform: "linux",
    _testScope: fixture.scope,
    _skipHealthWait: true,
    _supervisorOverride: fixture.supervisor as never,
  };
}

function withHermeticLifecycleSeams(
  options: Parameters<typeof ensureDaemon>[0],
  root: string,
): Parameters<typeof ensureDaemon>[0] {
  const stateDir = dirname(options.pidFilePath);
  const runtimeDir = join(root, "hermetic-runtime");
  const credentialDir = join(root, "hermetic-credentials");
  const procRoot = join(root, "hermetic-proc");
  for (const directory of [runtimeDir, stateDir, credentialDir, procRoot]) {
    mkdirSync(directory, { recursive: true });
  }
  const seams: DaemonLifecycleHermeticTestSeams = {
    homeDir: root,
    runtimeDir,
    stateDir,
    credentialDir,
    procRoot,
    platform: options._platform ?? "linux",
    uid: options._uid ?? 1000,
    environment: {},
    fetch: options._fetchOverride
      ?? (vi.fn().mockRejectedValue(new Error("hermetic offline")) as never),
    spawn: options._spawnOverride
      ?? (vi.fn(() => ({ pid: undefined, once: vi.fn().mockReturnThis(), unref: vi.fn() })) as never),
    spawnSync: options._spawnSyncOverride
      ?? (vi.fn(() => ({ status: 1, stdout: "", stderr: "hermetic" })) as never),
    stopUnit: vi.fn(),
    killProcess: options._killOverride ?? vi.fn(),
    isProcessAlive: options._isProcessAliveOverride ?? (() => false),
    sleep: options._sleepOverride ?? (async () => undefined),
    realpath: options._realpathOverride ?? (path => path),
  };
  return { ...options, _hermeticTestSeams: seams };
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
    expect(() => assertLifecycleScopeOwnsCurrentCleanupRoot(
      fixture.scope,
      fixture.scope.runtimeDir,
    )).not.toThrow();
    expect(() => assertLifecycleScopeOwnsCurrentCleanupRoot(
      fixture.scope,
      fixture.scope.credentialDir,
    )).not.toThrow();
    expect(() => assertLifecycleScopeOwnsCurrentCleanupRoot(
      fixture.scope,
      fixture.scope.stateDir,
    )).not.toThrow();
    expect(() => assertLifecycleScopeOwnsCurrentCleanupRoot(
      fixture.scope,
      join(fixture.root, "foreign"),
    )).toThrow("not current owned state");
    const replacementEntrypoint = join(
      fixture.root,
      "replacement-entrypoint.mjs",
    );
    writeFileSync(replacementEntrypoint, "replacement entrypoint\n");
    renameSync(replacementEntrypoint, fixture.scope.entrypoint);
    expect(() => assertLifecycleScopeOwnsCurrentCleanupRoot(
      fixture.scope,
      fixture.scope.runtimeDir,
    )).toThrow("not current owned state");
    expect(lifecycleScopeUnitName(fixture.scope, 12, 34)).toBe(
      "lcm-test-daemon-scope-valid-12-34",
    );
  });

  it("validates canonical resource kinds and rejects symbol-bearing nested scope data", () => {
    const fixture = createFixture("scope-descriptors");
    expect(isCanonicalLifecycleTestDirectory(fixture.scope.homeDir)).toBe(true);
    expect(isCanonicalLifecycleTestDirectory("relative")).toBe(false);
    expect(isCanonicalLifecycleTestDirectory(fixture.scope.entrypoint)).toBe(false);
    expect(isCanonicalLifecycleTestRegularFile(fixture.scope.entrypoint)).toBe(true);
    expect(isCanonicalLifecycleTestRegularFile("relative")).toBe(false);
    expect(isCanonicalLifecycleTestRegularFile(fixture.scope.homeDir)).toBe(false);

    expect(isDaemonLifecycleTestScope({
      ...fixture.scope,
      [Symbol("foreign")]: true,
    })).toBe(false);
    expect(isDaemonLifecycleTestScope({
      ...fixture.scope,
      dependencies: {
        ...fixture.scope.dependencies,
        [Symbol("foreign")]: vi.fn(),
      },
    })).toBe(false);
    expect(isDaemonLifecycleTestScope({
      ...fixture.scope,
      filesystem: {
        ...fixture.scope.filesystem,
        [Symbol("foreign")]: true,
      },
    })).toBe(false);
    const pathGetter = vi.fn(() => fixture.scope.filesystem.stateDir.path);
    const stateSnapshot = { ...fixture.scope.filesystem.stateDir };
    Object.defineProperty(stateSnapshot, "path", {
      configurable: true,
      enumerable: true,
      get: pathGetter,
    });
    expect(isDaemonLifecycleTestScope({
      ...fixture.scope,
      filesystem: {
        ...fixture.scope.filesystem,
        stateDir: stateSnapshot,
      },
    })).toBe(false);
    expect(pathGetter).not.toHaveBeenCalled();
  });

  it("rejects symlinked leaves and ancestors while accepting real resources", () => {
    const fixture = createFixture("scope-canonical");
    const linkedEntrypoint = join(fixture.scope.runtimeDir, "linked-daemon.mjs");
    symlinkSync(fixture.scope.entrypoint, linkedEntrypoint, "file");
    expect(() => createDaemonLifecycleTestScope({
      ...fixture.scope,
      entrypoint: linkedEntrypoint,
    })).toThrow("canonical file");

    const aliasRoot = mkdtempSync(join(tmpdir(), "lcm-lifecycle-alias-"));
    roots.push(aliasRoot);
    const homeDir = join(aliasRoot, "home");
    const runtimeDir = join(homeDir, "runtime");
    const credentialDir = join(homeDir, "credentials");
    const targetStateDir = join(aliasRoot, "canonical-state-target");
    const entrypoint = join(runtimeDir, "owned-daemon.mjs");
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(credentialDir, { recursive: true });
    mkdirSync(targetStateDir, { recursive: true });
    writeFileSync(entrypoint, "export {};\n");
    writeFileSync(join(targetStateDir, "sentinel"), "untouched");
    symlinkSync(targetStateDir, join(homeDir, ".lcm"), "dir");
    expect(() => createDaemonLifecycleTestScope({
      ownerId: "scope-state-alias",
      homeDir,
      runtimeDir,
      stateDir: join(homeDir, ".lcm"),
      credentialDir,
      entrypoint,
      dependencies: fixture.scope.dependencies,
    })).toThrow("canonical directory");
    expect(readFileSync(join(targetStateDir, "sentinel"), "utf-8")).toBe("untouched");

    const realHome = join(aliasRoot, "real-home");
    const linkedHome = join(aliasRoot, "linked-home");
    mkdirSync(join(realHome, "runtime"), { recursive: true });
    mkdirSync(join(realHome, ".lcm"), { recursive: true });
    mkdirSync(join(realHome, "credentials"), { recursive: true });
    writeFileSync(join(realHome, "runtime", "owned-daemon.mjs"), "export {};\n");
    symlinkSync(realHome, linkedHome, "dir");
    expect(() => createDaemonLifecycleTestScope({
      ownerId: "scope-home-alias",
      homeDir: linkedHome,
      runtimeDir: join(linkedHome, "runtime"),
      stateDir: join(linkedHome, ".lcm"),
      credentialDir: join(linkedHome, "credentials"),
      entrypoint: join(linkedHome, "runtime", "owned-daemon.mjs"),
      dependencies: fixture.scope.dependencies,
    })).toThrow("canonical directory");
  });

  it("rejects a hardlinked entrypoint without mutating its inode", async () => {
    const fixture = createFixture("scope-entrypoint-hardlink");
    const targetRoot = mkdtempSync(join(tmpdir(), "lcm-lifecycle-entrypoint-hardlink-"));
    roots.push(targetRoot);
    const secondLink = join(targetRoot, "owned-daemon.mjs");
    linkSync(fixture.scope.entrypoint, secondLink);
    const contentBefore = readFileSync(secondLink, "utf-8");
    const modeBefore = statSync(secondLink).mode & 0o777;
    await expect(ensureDaemon(scopedOptions(fixture))).resolves.toMatchObject({
      connected: false,
      spawned: false,
      warning: expect.stringContaining("incomplete or malformed"),
    });
    expect(readFileSync(secondLink, "utf-8")).toBe(contentBefore);
    expect(statSync(secondLink).mode & 0o777).toBe(modeBefore);
    expect(fixture.scope.dependencies.fetch).not.toHaveBeenCalled();
    expect(fixture.runSystemd).not.toHaveBeenCalled();
    expect(fixture.spawnProcess).not.toHaveBeenCalled();
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.stopUnit).not.toHaveBeenCalled();
  });

  it("rejects accessor-bearing scope objects without invoking getters", async () => {
    const fixture = createFixture("scope-accessor");
    const getter = vi.fn(() => fixture.scope.stateDir);
    const malformed = { ...fixture.scope };
    Object.defineProperty(malformed, "stateDir", {
      configurable: true,
      enumerable: true,
      get: getter,
    });
    await expect(ensureDaemon({
      ...scopedOptions(fixture),
      _testScope: malformed as never,
    })).resolves.toMatchObject({
      connected: false,
      warning: expect.stringContaining("incomplete or malformed"),
    });
    expect(getter).not.toHaveBeenCalled();
    expect(fixture.scope.dependencies.fetch).not.toHaveBeenCalled();
    expect(fixture.runSystemd).not.toHaveBeenCalled();
    expect(fixture.spawnProcess).not.toHaveBeenCalled();
    expect(fixture.killProcess).not.toHaveBeenCalled();
  });

  it.each([
    [{ ownerId: "bad owner" }, "ownerId"],
    [{ homeDir: "relative" }, "homeDir"],
    [{ runtimeDir: "/outside" }, "runtimeDir"],
    [{ stateDir: "/outside" }, "stateDir must equal"],
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
      warning: expect.stringContaining("canonical owned state"),
    });
    expect(fixture.runSystemd).not.toHaveBeenCalled();
    expect(fixture.spawnProcess).not.toHaveBeenCalled();
    expect(fixture.killProcess).not.toHaveBeenCalled();
  });

  it("rejects a directory-shaped PID boundary before token or lifecycle access", async () => {
    const fixture = createFixture("scope-boundary-ensure");
    const escapedTokenPath = join(dirname(fixture.scope.stateDir), "daemon.token");
    writeFileSync(escapedTokenPath, "boundary-token", { mode: 0o644 });
    const tokenBefore = readFileSync(escapedTokenPath, "utf8");
    const tokenModeBefore = statSync(escapedTokenPath).mode & 0o777;
    const stateBefore = readdirSync(fixture.scope.stateDir);
    await expect(ensureDaemon({
      ...scopedOptions(fixture),
      pidFilePath: fixture.scope.stateDir,
    })).resolves.toMatchObject({
      connected: false,
      spawned: false,
      warning: expect.stringContaining("canonical owned state"),
    });
    expect(readFileSync(escapedTokenPath, "utf8")).toBe(tokenBefore);
    expect(statSync(escapedTokenPath).mode & 0o777).toBe(tokenModeBefore);
    expect(readdirSync(fixture.scope.stateDir)).toEqual(stateBefore);
    expect(fixture.scope.dependencies.fetch).not.toHaveBeenCalled();
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.runSystemd).not.toHaveBeenCalled();
    expect(fixture.spawnProcess).not.toHaveBeenCalled();
  });

  it.each(["daemon.pid", "daemon.token"] as const)(
    "rejects a symlinked %s leaf before target or lifecycle access",
    async (leaf) => {
      const fixture = createFixture(`scope-leaf-${leaf.replace(".", "-")}`);
      const targetRoot = mkdtempSync(join(tmpdir(), "lcm-lifecycle-leaf-target-"));
      roots.push(targetRoot);
      const target = join(targetRoot, leaf);
      writeFileSync(target, `target-${leaf}`, { mode: 0o640 });
      symlinkSync(target, join(fixture.scope.stateDir, leaf), "file");
      const contentBefore = readFileSync(target, "utf-8");
      const modeBefore = statSync(target).mode & 0o777;
      await expect(ensureDaemon(scopedOptions(fixture))).resolves.toMatchObject({
        connected: false,
        spawned: false,
        warning: expect.stringContaining("canonical owned state"),
      });
      expect(readFileSync(target, "utf-8")).toBe(contentBefore);
      expect(statSync(target).mode & 0o777).toBe(modeBefore);
      expect(fixture.scope.dependencies.fetch).not.toHaveBeenCalled();
      expect(fixture.runSystemd).not.toHaveBeenCalled();
      expect(fixture.spawnProcess).not.toHaveBeenCalled();
      expect(fixture.killProcess).not.toHaveBeenCalled();
      expect(fixture.stopUnit).not.toHaveBeenCalled();
    },
  );

  it.each(["daemon.pid", "daemon.token"] as const)(
    "rejects a hardlinked %s leaf without mutating its target",
    async (leaf) => {
      const fixture = createFixture(`scope-hardlink-${leaf.replace(".", "-")}`);
      const targetRoot = mkdtempSync(join(tmpdir(), "lcm-lifecycle-hardlink-target-"));
      roots.push(targetRoot);
      const target = join(targetRoot, leaf);
      writeFileSync(target, leaf === "daemon.pid" ? "8181" : "target-secret", {
        mode: 0o640,
      });
      linkSync(target, join(fixture.scope.stateDir, leaf));
      const contentBefore = readFileSync(target, "utf-8");
      const modeBefore = statSync(target).mode & 0o777;
      await expect(ensureDaemon(scopedOptions(fixture))).resolves.toMatchObject({
        connected: false,
        spawned: false,
        warning: expect.stringContaining("canonical owned state"),
      });
      expect(readFileSync(target, "utf-8")).toBe(contentBefore);
      expect(statSync(target).mode & 0o777).toBe(modeBefore);
      expect(fixture.scope.dependencies.fetch).not.toHaveBeenCalled();
      expect(fixture.runSystemd).not.toHaveBeenCalled();
      expect(fixture.spawnProcess).not.toHaveBeenCalled();
      expect(fixture.killProcess).not.toHaveBeenCalled();
      expect(fixture.stopUnit).not.toHaveBeenCalled();
    },
  );

  it("fails closed for malformed, conflicting, or out-of-root hermetic seams", async () => {
    const fixture = createFixture("hermetic-preflight");
    const options = withHermeticLifecycleSeams({
      port: 37_343,
      pidFilePath: fixture.pidPath,
      spawnTimeoutMs: 10,
    }, fixture.scope.homeDir);
    const seams = options._hermeticTestSeams!;
    expect(isDaemonLifecycleHermeticTestSeams(seams)).toBe(true);
    expect(isDaemonLifecycleHermeticTestSeams(seams)).toBe(true);
    expect(isDaemonLifecycleHermeticTestSeams(null)).toBe(false);
    expect(isDaemonLifecycleHermeticTestSeams({ ...seams, homeDir: "/" })).toBe(false);
    expect(isDaemonLifecycleHermeticTestSeams({ ...seams, homeDir: "relative" })).toBe(false);
    expect(isDaemonLifecycleHermeticTestSeams({ ...seams, runtimeDir: "/outside" })).toBe(false);
    const outsideRoot = mkdtempSync(join(tmpdir(), "lcm-hermetic-outside-"));
    roots.push(outsideRoot);
    expect(isDaemonLifecycleHermeticTestSeams({
      ...seams,
      runtimeDir: outsideRoot,
    })).toBe(false);
    expect(isDaemonLifecycleHermeticTestSeams({ ...seams, uid: -1 })).toBe(false);
    expect(isDaemonLifecycleHermeticTestSeams({ ...seams, platform: "" })).toBe(false);
    expect(isDaemonLifecycleHermeticTestSeams({ ...seams, environment: null })).toBe(false);
    expect(isDaemonLifecycleHermeticTestSeams({ ...seams, spawn: undefined })).toBe(false);
    await expect(ensureDaemon({
      ...options,
      _hermeticTestSeams: {
        ...options._hermeticTestSeams!,
        fetch: undefined,
      } as never,
    })).resolves.toMatchObject({
      connected: false,
      warning: expect.stringContaining("incomplete or malformed"),
    });
    await expect(restartDaemon({
      ...options,
      _hermeticTestSeams: {
        ...options._hermeticTestSeams!,
        uid: -1,
      } as never,
    })).resolves.toMatchObject({
      restarted: false,
      warning: expect.stringContaining("incomplete or malformed"),
    });
    await expect(ensureDaemon({
      ...scopedOptions(fixture),
      _hermeticTestSeams: options._hermeticTestSeams,
    })).resolves.toMatchObject({
      connected: false,
      warning: expect.stringContaining("conflicts"),
    });
    await expect(restartDaemon({
      ...scopedOptions(fixture),
      _hermeticTestSeams: options._hermeticTestSeams,
    })).resolves.toMatchObject({
      restarted: false,
      warning: expect.stringContaining("conflicts"),
    });
    const foreignSeams = {
      ...options._hermeticTestSeams!,
      stateDir: join(fixture.scope.homeDir, "foreign-state"),
    };
    mkdirSync(foreignSeams.stateDir);
    await expect(ensureDaemon({
      ...options,
      _hermeticTestSeams: foreignSeams,
    })).resolves.toMatchObject({
      connected: false,
      warning: expect.stringContaining("outside its state root"),
    });
    await expect(restartDaemon({
      ...options,
      _hermeticTestSeams: foreignSeams,
    })).resolves.toMatchObject({
      restarted: false,
      warning: expect.stringContaining("outside its state root"),
    });
    expect(fixture.scope.dependencies.fetch).not.toHaveBeenCalled();
  });

  it("rejects symlinked hermetic roots and ancestors before external state access", async () => {
    const externalRoot = mkdtempSync(join(tmpdir(), "lcm-hermetic-external-"));
    roots.push(externalRoot);
    const externalState = join(externalRoot, "state");
    mkdirSync(externalState);

    async function expectBlocked(
      label: string,
      prepare: (
        root: string,
        seams: DaemonLifecycleHermeticTestSeams,
      ) => DaemonLifecycleHermeticTestSeams,
    ): Promise<void> {
      const root = mkdtempSync(join(tmpdir(), `lcm-hermetic-${label}-`));
      roots.push(root);
      const stateDir = join(root, "state");
      const pidPath = join(stateDir, "daemon.pid");
      const options = withHermeticLifecycleSeams({
        port: 37_347,
        pidFilePath: pidPath,
        spawnTimeoutMs: 10,
      }, root);
      const originalSeams = options._hermeticTestSeams!;
      expect(isDaemonLifecycleHermeticTestSeams(originalSeams)).toBe(true);
      const seams = prepare(root, originalSeams);
      const ownedPidPath = join(seams.stateDir, "daemon.pid");
      const ownedTokenPath = join(seams.stateDir, "daemon.token");
      mkdirSync(seams.stateDir, { recursive: true });
      writeFileSync(ownedPidPath, "8282");
      writeFileSync(ownedTokenPath, "seam-token", { mode: 0o640 });
      const ownedPidBefore = readFileSync(ownedPidPath, "utf8");
      const ownedTokenBefore = readFileSync(ownedTokenPath, "utf8");
      const ownedTokenModeBefore = statSync(ownedTokenPath).mode & 0o777;
      const validateBeforeRestart = vi.fn();

      expect(isDaemonLifecycleHermeticTestSeams(seams)).toBe(false);
      await expect(ensureDaemon({
        ...options,
        pidFilePath: ownedPidPath,
        _hermeticTestSeams: seams,
      })).resolves.toMatchObject({
        connected: false,
        spawned: false,
        warning: expect.stringContaining("incomplete or malformed"),
      });
      await expect(restartDaemon({
        ...options,
        pidFilePath: ownedPidPath,
        _hermeticTestSeams: seams,
        validateBeforeRestart,
      })).resolves.toMatchObject({
        connected: false,
        spawned: false,
        restarted: false,
        warning: expect.stringContaining("incomplete or malformed"),
      });
      expect(validateBeforeRestart).not.toHaveBeenCalled();
      expect(seams.fetch).not.toHaveBeenCalled();
      expect(seams.spawn).not.toHaveBeenCalled();
      expect(seams.spawnSync).not.toHaveBeenCalled();
      expect(seams.killProcess).not.toHaveBeenCalled();
      expect(readFileSync(ownedPidPath, "utf8")).toBe(ownedPidBefore);
      expect(readFileSync(ownedTokenPath, "utf8")).toBe(ownedTokenBefore);
      expect(statSync(ownedTokenPath).mode & 0o777).toBe(ownedTokenModeBefore);
    }

    await expectBlocked("state-link", (_root, seams) => {
      rmSync(seams.stateDir, { recursive: true });
      symlinkSync(externalState, seams.stateDir, "dir");
      return seams;
    });
    await expectBlocked("state-replacement", (_root, seams) => {
      renameSync(seams.stateDir, `${seams.stateDir}-original`);
      mkdirSync(seams.stateDir);
      return seams;
    });
    await expectBlocked("runtime-link", (_root, seams) => {
      rmSync(seams.runtimeDir, { recursive: true });
      symlinkSync(externalRoot, seams.runtimeDir, "dir");
      return seams;
    });
    await expectBlocked("credential-link", (_root, seams) => {
      rmSync(seams.credentialDir, { recursive: true });
      symlinkSync(externalRoot, seams.credentialDir, "dir");
      return seams;
    });
    await expectBlocked("proc-link", (_root, seams) => {
      rmSync(seams.procRoot, { recursive: true });
      symlinkSync(externalRoot, seams.procRoot, "dir");
      return seams;
    });
    await expectBlocked("home-link", (root, seams) => {
      const externalHome = join(externalRoot, "home");
      mkdirSync(join(externalHome, "hermetic-runtime"), { recursive: true });
      mkdirSync(join(externalHome, "state"), { recursive: true });
      mkdirSync(join(externalHome, "hermetic-credentials"), { recursive: true });
      mkdirSync(join(externalHome, "hermetic-proc"), { recursive: true });
      rmSync(root, { recursive: true });
      symlinkSync(externalHome, root, "dir");
      return seams;
    });
    await expectBlocked("ancestor-swap", (root) => {
      const home = join(root, "owned", "home");
      mkdirSync(home, { recursive: true });
      const nestedOptions = withHermeticLifecycleSeams({
        port: 37_348,
        pidFilePath: join(home, "state", "daemon.pid"),
        spawnTimeoutMs: 10,
      }, home);
      const originalParent = join(root, "owned-original");
      renameSync(join(root, "owned"), originalParent);
      const externalParent = join(externalRoot, "owned");
      mkdirSync(join(externalParent, "home", "hermetic-runtime"), { recursive: true });
      mkdirSync(join(externalParent, "home", "state"), { recursive: true });
      mkdirSync(join(externalParent, "home", "hermetic-credentials"), { recursive: true });
      mkdirSync(join(externalParent, "home", "hermetic-proc"), { recursive: true });
      symlinkSync(externalParent, join(root, "owned"), "dir");
      return nestedOptions._hermeticTestSeams!;
    });
  });

  it("rejects hermetic PID and token symlinks or hardlinks before ensure and restart", async () => {
    for (const linkKind of ["symlink", "hardlink"] as const) {
      for (const leaf of ["daemon.pid", "daemon.token"] as const) {
        const root = mkdtempSync(join(tmpdir(), `lcm-hermetic-${linkKind}-${leaf}-`));
        roots.push(root);
        const stateDir = join(root, "state");
        const pidPath = join(stateDir, "daemon.pid");
        const tokenPath = join(stateDir, "daemon.token");
        const options = withHermeticLifecycleSeams({
          port: 37_353,
          pidFilePath: pidPath,
          spawnTimeoutMs: 10,
        }, root);
        const seams = options._hermeticTestSeams!;
        const external = join(root, `external-${leaf}`);
        writeFileSync(external, `external-${linkKind}-${leaf}`, { mode: 0o640 });
        const linkedPath = join(stateDir, leaf);
        if (linkKind === "symlink") symlinkSync(external, linkedPath, "file");
        else linkSync(external, linkedPath);
        const contentBefore = readFileSync(external, "utf8");
        const modeBefore = statSync(external).mode & 0o777;
        const validateBeforeRestart = vi.fn();

        expect(isDaemonLifecycleHermeticTestSeams(seams)).toBe(true);
        await expect(ensureDaemon({
          ...options,
          _hermeticTestSeams: seams,
        })).resolves.toMatchObject({
          connected: false,
          spawned: false,
          warning: expect.stringContaining("outside its state root"),
        });
        await expect(restartDaemon({
          ...options,
          _hermeticTestSeams: seams,
          validateBeforeRestart,
        })).resolves.toMatchObject({
          connected: false,
          spawned: false,
          restarted: false,
          warning: expect.stringContaining("outside its state root"),
        });
        expect(validateBeforeRestart).not.toHaveBeenCalled();
        expect(seams.fetch).not.toHaveBeenCalled();
        expect(seams.spawn).not.toHaveBeenCalled();
        expect(seams.spawnSync).not.toHaveBeenCalled();
        expect(seams.killProcess).not.toHaveBeenCalled();
        expect(readFileSync(external, "utf8")).toBe(contentBefore);
        expect(statSync(external).mode & 0o777).toBe(modeBefore);
      }
    }
  });

  it("revalidates hermetic root snapshots after injected callbacks", async () => {
    function createAncestorSwap(
      label: string,
    ): {
      options: Parameters<typeof ensureDaemon>[0];
      seams: DaemonLifecycleHermeticTestSeams;
      swap: ReturnType<typeof vi.fn>;
      externalPid: string;
      externalToken: string;
    } {
      const root = mkdtempSync(join(tmpdir(), `lcm-hermetic-swap-${label}-`));
      roots.push(root);
      const home = join(root, "owned", "home");
      mkdirSync(home, { recursive: true });
      const options = withHermeticLifecycleSeams({
        port: 37_349,
        pidFilePath: join(home, "state", "daemon.pid"),
        spawnTimeoutMs: 10,
      }, home);
      const seams = options._hermeticTestSeams!;
      expect(isDaemonLifecycleHermeticTestSeams(seams)).toBe(true);
      const externalParent = join(root, "external-owned");
      const externalHome = join(externalParent, "home");
      for (const directory of [
        join(externalHome, "hermetic-runtime"),
        join(externalHome, "state"),
        join(externalHome, "hermetic-credentials"),
        join(externalHome, "hermetic-proc"),
      ]) {
        mkdirSync(directory, { recursive: true });
      }
      const externalPid = join(externalHome, "state", "daemon.pid");
      const externalToken = join(externalHome, "state", "daemon.token");
      writeFileSync(externalPid, "8383");
      writeFileSync(externalToken, "external-swap-token", { mode: 0o640 });
      const swap = vi.fn(() => {
        renameSync(join(root, "owned"), join(root, "owned-original"));
        symlinkSync(externalParent, join(root, "owned"), "dir");
      });
      return { options, seams, swap, externalPid, externalToken };
    }

    const restartCase = createAncestorSwap("restart");
    const validateBeforeRestart = vi.fn(async () => restartCase.swap());
    await expect(restartDaemon({
      ...restartCase.options,
      _hermeticTestSeams: restartCase.seams,
      validateBeforeRestart,
    })).resolves.toMatchObject({
      connected: false,
      spawned: false,
      restarted: false,
      warning: expect.stringContaining("state changed during restart validation"),
    });
    expect(validateBeforeRestart).toHaveBeenCalledOnce();
    expect(restartCase.seams.fetch).not.toHaveBeenCalled();
    expect(restartCase.seams.killProcess).not.toHaveBeenCalled();
    expect(readFileSync(restartCase.externalPid, "utf8")).toBe("8383");
    expect(readFileSync(restartCase.externalToken, "utf8")).toBe("external-swap-token");
    expect(statSync(restartCase.externalToken).mode & 0o777).toBe(0o640);

    const ensureCase = createAncestorSwap("ensure");
    const fetch = vi.fn(async () => {
      ensureCase.swap();
      return { ok: false, status: 503 };
    });
    const seams = {
      ...ensureCase.seams,
      fetch: fetch as never,
    };
    expect(isDaemonLifecycleHermeticTestSeams(seams)).toBe(true);
    await expect(ensureDaemon({
      ...ensureCase.options,
      _hermeticTestSeams: seams,
    })).rejects.toThrow("PID state is not a canonical owned file");
    expect(fetch).toHaveBeenCalledOnce();
    expect(seams.spawn).not.toHaveBeenCalled();
    expect(seams.spawnSync).not.toHaveBeenCalled();
    expect(seams.killProcess).not.toHaveBeenCalled();
    expect(readFileSync(ensureCase.externalPid, "utf8")).toBe("8383");
    expect(readFileSync(ensureCase.externalToken, "utf8")).toBe("external-swap-token");
    expect(statSync(ensureCase.externalToken).mode & 0o777).toBe(0o640);
  });

  it("preserves best-effort stale PID recovery for a hermetic production-shaped error", async () => {
    const fixture = createFixture("hermetic-stale-error");
    writeFileSync(fixture.pidPath, "9195");
    const options = withHermeticLifecycleSeams({
      port: 37_346,
      pidFilePath: fixture.pidPath,
      spawnTimeoutMs: 10,
      _skipSpawn: true,
      _isProcessAliveOverride: () => {
        throw new Error("process inspection unavailable");
      },
    }, fixture.scope.homeDir);
    await expect(ensureDaemon(options)).resolves.toMatchObject({
      connected: false,
      spawned: false,
      refusalReason: "ambiguous",
    });
    expect(existsSync(fixture.pidPath)).toBe(true);
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

  it("does not treat an abort signal alone as an isolation seam", async () => {
    expect(isVitestWorkerEntrypoint(process.argv[1])).toBe(true);
    const root = mkdtempSync(join(tmpdir(), "lcm-abort-only-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const pidPath = join(stateDir, "daemon.pid");
    const tokenPath = join(stateDir, "daemon.token");
    const controller = new AbortController();
    const fetch = vi.spyOn(globalThis, "fetch");
    const kill = vi.spyOn(process, "kill");
    await expect(ensureDaemon({
      port: 37_341,
      pidFilePath: pidPath,
      spawnTimeoutMs: 10,
      _abortSignal: controller.signal,
    })).resolves.toMatchObject({
      connected: false,
      spawned: false,
      warning: expect.stringContaining("unscoped Vitest worker"),
    });
    expect(controller.signal.aborted).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(existsSync(pidPath)).toBe(false);
    expect(existsSync(tokenPath)).toBe(false);
    expect(existsSync(stateDir)).toBe(false);
  });

  it("rejects no-op partial seams for ensure and restart before side effects", async () => {
    expect(isVitestWorkerEntrypoint(process.argv[1])).toBe(true);
    const root = mkdtempSync(join(tmpdir(), "lcm-partial-seams-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const pidPath = join(stateDir, "daemon.pid");
    const tokenPath = join(stateDir, "daemon.token");
    const fetch = vi.spyOn(globalThis, "fetch");
    const kill = vi.spyOn(process, "kill");
    const validateBeforeRestart = vi.fn();
    await expect(ensureDaemon({
      port: 37_342,
      pidFilePath: pidPath,
      spawnTimeoutMs: 10,
      _skipHealthWait: false,
      _platform: process.platform,
    })).resolves.toMatchObject({
      connected: false,
      spawned: false,
      warning: expect.stringContaining("unscoped Vitest worker"),
    });
    await expect(restartDaemon({
      port: 37_342,
      pidFilePath: pidPath,
      spawnTimeoutMs: 10,
      _skipHealthWait: false,
      _platform: process.platform,
      validateBeforeRestart,
    })).resolves.toMatchObject({
      connected: false,
      spawned: false,
      restarted: false,
      warning: expect.stringContaining("unscoped Vitest worker"),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(validateBeforeRestart).not.toHaveBeenCalled();
    expect(existsSync(pidPath)).toBe(false);
    expect(existsSync(tokenPath)).toBe(false);
    expect(existsSync(stateDir)).toBe(false);
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
    await expect(ensureDaemon(withHermeticLifecycleSeams({
      port: 37_338,
      pidFilePath: join(fixture.root, "worker-entrypoint", "daemon.pid"),
      spawnTimeoutMs: 10,
      expectedEntrypoint: process.argv[1],
      _fetchOverride: vi.fn() as never,
    }, fixture.root))).resolves.toMatchObject({
      connected: false,
      warning: expect.stringContaining("Vitest worker as a daemon entrypoint"),
    });

    const ambientWorkerEntrypoint = process.argv[1];
    process.argv[1] = fixture.scope.entrypoint;
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    try {
      await expect(ensureDaemon({
        port: 37_344,
        pidFilePath: join(fixture.scope.stateDir, "worker-spawn.pid"),
        spawnTimeoutMs: 100,
        expectedEntrypoint: fixture.scope.entrypoint,
        spawnArgs: [ambientWorkerEntrypoint],
        _skipHealthWait: true,
      })).resolves.toMatchObject({
        connected: false,
        warning: expect.stringContaining("register a Vitest worker"),
      });
      expect(existsSync(join(fixture.scope.stateDir, "worker-spawn.pid"))).toBe(false);
      expect(existsSync(join(fixture.scope.stateDir, "daemon.token"))).toBe(false);
    } finally {
      process.argv[1] = ambientWorkerEntrypoint;
    }
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
      warning: expect.stringContaining("unscoped Vitest worker"),
    });
    expect(existsSync(fixture.pidPath)).toBe(false);
    expect(existsSync(fixture.tokenPath)).toBe(false);
    expect(readdirSync(fixture.scope.stateDir)).toEqual(stateBefore);
  });

  it("uses a stable canonical manager name for a fully mocked no-scope production invocation", async () => {
    const fixture = createFixture("production-default");
    const previousEntrypoint = process.argv[1];
    process.argv[1] = fixture.scope.entrypoint;
    let observedSpec: { scopeDigest: string; nonce: string; name: string } | undefined;
    let started = false;
    const supervisor = {
      probe: vi.fn(async (spec: typeof observedSpec) => {
        observedSpec = spec!;
        return started
          ? { kind: "registered-running-valid" as const, managerPid: 42_424, scopeDigest: spec!.scopeDigest, nonce: spec!.nonce, name: spec!.name }
          : { kind: "absent" as const, name: spec!.name };
      }),
      start: vi.fn(async (spec: typeof observedSpec) => {
        started = true;
        return { kind: "systemd-user" as const, name: spec!.name, scopeDigest: spec!.scopeDigest, nonce: spec!.nonce, port: 37_345, managerPid: 42_424 };
      }),
      stopAndStart: vi.fn(),
      stopAndAwaitAbsent: vi.fn(),
    };
    try {
      await expect(ensureDaemon({
        port: 37_345,
        pidFilePath: fixture.pidPath,
        spawnTimeoutMs: 100,
        expectedEntrypoint: fixture.scope.entrypoint,
        enforceUserManagerParent: true,
        spawnArgs: [fixture.scope.entrypoint],
        _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as never,
        _spawnOverride: fixture.spawnProcess as never,
        _supervisorOverride: supervisor as never,
        _killOverride: fixture.killProcess,
        _isProcessAliveOverride: (): boolean => false,
        _sleepOverride: async () => undefined,
        _realpathOverride: path => path,
        _platform: "linux",
        _procRoot: join(fixture.root, "proc"),
        _uid: 1000,
        _skipHealthWait: true,
      })).resolves.toMatchObject({
        connected: false,
        spawned: true,
        startMethod: "systemd-user",
      });
    } finally {
      process.argv[1] = previousEntrypoint;
    }
    expect(observedSpec?.name).toMatch(/^lcm-daemon-[a-f0-9]{20}\.service$/u);
    expect(supervisor.probe).toHaveBeenCalledTimes(2);
    expect(supervisor.start).toHaveBeenCalledOnce();
  });

  it("preserves no-scope production PID cleanup and detached PID writes", async () => {
    const fixture = createFixture("production-state-defaults");
    const previousEntrypoint = process.argv[1];
    process.argv[1] = fixture.scope.entrypoint;
    const pidPath = join(fixture.root, "production.pid");
    const missingPidPath = join(fixture.root, "missing-production.pid");
    const detachedPidPath = join(fixture.root, "detached-production.pid");
    const ensureReplacement = vi.fn(async () => ({
      connected: false,
      port: 37_350,
      spawned: false,
    }));
    try {
      writeFileSync(pidPath, "8484");
      await expect(restartDaemon({
        port: 37_350,
        pidFilePath: pidPath,
        spawnTimeoutMs: 10,
        _isProcessAliveOverride: () => false,
        _ensureDaemonOverride: ensureReplacement,
      })).resolves.toMatchObject({
        connected: false,
        restarted: false,
      });
      expect(existsSync(pidPath)).toBe(false);
      await expect(restartDaemon({
        port: 37_350,
        pidFilePath: missingPidPath,
        spawnTimeoutMs: 10,
        _ensureDaemonOverride: ensureReplacement,
      })).resolves.toMatchObject({
        connected: false,
        restarted: false,
      });

      const child = {
        pid: 8585,
        once: vi.fn().mockReturnThis(),
        unref: vi.fn(),
      };
      await expect(ensureDaemon({
        port: 37_350,
        pidFilePath: detachedPidPath,
        spawnTimeoutMs: 10,
        spawnArgs: [fixture.scope.entrypoint],
        _platform: "darwin",
        _fetchOverride: vi.fn().mockRejectedValue(new Error("offline")) as never,
        _spawnOverride: vi.fn(() => child) as never,
        _skipHealthWait: true,
      })).resolves.toMatchObject({
        connected: false,
        spawned: true,
        startMethod: "detached-spawn",
      });
      expect(readFileSync(detachedPidPath, "utf8")).toBe("8585");

      const health = {
        status: "ok",
        version: "1",
        storageBackend: "sqlite",
        pid: 8686,
        entrypoint: fixture.scope.entrypoint,
        runtimeDigest: RUNTIME_DIGEST,
      };
      const fetchHealthy = vi.fn(async (url: string) => (
        url.endsWith("/health")
          ? { ok: true, status: 200, json: async () => health }
          : { ok: true, status: 200, json: async () => ({}) }
      ));
      const connectedRoot = join(fixture.root, "connected");
      mkdirSync(connectedRoot);
      const connectedPidPath = join(connectedRoot, "daemon.pid");
      writeFileSync(connectedPidPath, "8686");
      ensureAuthToken(join(connectedRoot, "daemon.token"));
      await expect(ensureDaemon({
        port: 37_351,
        pidFilePath: connectedPidPath,
        spawnTimeoutMs: 10,
        expectedVersion: "1",
        expectedEntrypoint: fixture.scope.entrypoint,
        _platform: "darwin",
        _fetchOverride: fetchHealthy as never,
        _isProcessAliveOverride: () => true,
        _listeningPortsOverride: () => [37_351],
        _monotonicNowOverride: () => 0,
        _skipSpawn: true,
      })).resolves.toMatchObject({
        connected: true,
        spawned: false,
      });

      const restartRoot = join(fixture.root, "restart");
      mkdirSync(restartRoot);
      const restartPidPath = join(restartRoot, "daemon.pid");
      writeFileSync(restartPidPath, "8787");
      ensureAuthToken(join(restartRoot, "daemon.token"));
      let alive = true;
      const kill = vi.fn(() => {
        alive = false;
      });
      const restartHealth = {
        ...health,
        pid: 8787,
      };
      const fetchRestart = vi.fn(async (url: string) => (
        url.endsWith("/health")
          ? { ok: true, status: 200, json: async () => restartHealth }
          : { ok: true, status: 200, json: async () => ({}) }
      ));
      const processIdentity = vi.fn((command: string) => command === "/bin/ps"
        ? { status: 0, stdout: "node lcm daemon start --foreground\n", stderr: "" }
        : { status: 0, stdout: "", stderr: "" });
      await expect(restartDaemon({
        port: 37_352,
        pidFilePath: restartPidPath,
        spawnTimeoutMs: 10,
        expectedVersion: "1",
        expectedEntrypoint: fixture.scope.entrypoint,
        _platform: "darwin",
        _fetchOverride: fetchRestart as never,
        _spawnSyncOverride: processIdentity as never,
        _isProcessAliveOverride: () => alive,
        _killOverride: kill,
        _sleepOverride: async () => undefined,
        _listeningPortsOverride: () => [37_352],
        _monotonicNowOverride: () => 0,
        _ensureDaemonOverride: async () => ({
          connected: false,
          port: 37_352,
          spawned: false,
        }),
      })).resolves.toMatchObject({
        restarted: true,
        stoppedPid: 8787,
      });
    } finally {
      process.argv[1] = previousEntrypoint;
    }
  });
});

describe("run-owned lifecycle resources", () => {
  it("rejects non-regular no-follow state descriptors", () => {
    const fixture = createFixture("owned-descriptor");
    const descriptor = openSync(fixture.scope.stateDir, "r");
    try {
      expect(() => __lifecycleTestUtils.requireRegularFileDescriptor(descriptor))
        .toThrow("state leaf is not a single-link regular file");
    } finally {
      closeSync(descriptor);
    }

    const stateFile = join(fixture.scope.stateDir, "descriptor-target");
    const secondLink = join(fixture.root, "descriptor-second-link");
    writeFileSync(stateFile, "unchanged", { mode: 0o640 });
    linkSync(stateFile, secondLink);
    const hardlinkedDescriptor = openSync(stateFile, "r");
    try {
      expect(() => __lifecycleTestUtils.requireRegularFileDescriptor(
        hardlinkedDescriptor,
      )).toThrow("state leaf is not a single-link regular file");
    } finally {
      closeSync(hardlinkedDescriptor);
    }
    expect(readFileSync(secondLink, "utf-8")).toBe("unchanged");
    expect(statSync(secondLink).mode & 0o777).toBe(0o640);
  });

  it("uses only the scoped unit, paths, credentials, environment, and entrypoint", async () => {
    const fixture = createFixture("owned-success");
    const previousSecret = process.env.LCM_SUMMARY_API_KEY;
    const previousDatabasePath = process.env.LCM_DATABASE_PATH;
    process.env.LCM_SUMMARY_API_KEY = "scope-secret";
    process.env.LCM_DATABASE_PATH = "/canonical/.lcm/lcm.db";
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
      if (previousDatabasePath === undefined) delete process.env.LCM_DATABASE_PATH;
      else process.env.LCM_DATABASE_PATH = previousDatabasePath;
    }
    expect(fixture.runSystemd).toHaveBeenCalledOnce();
    const [, args, options] = fixture.runSystemd.mock.calls[0]!;
    const unitArg = (args as string[]).find(arg => arg.startsWith("--unit="));
    expect(unitArg).toMatch(/^--unit=lcm-daemon-[a-f0-9]{20}\.service$/u);
    expect(args).toContain(`--setenv=HOME=${fixture.scope.homeDir}`);
    expect(args).toContain(`--setenv=LCM_DAEMON_OWNER_ID=${fixture.scope.ownerId}`);
    expect(args).toContain(`--setenv=XDG_RUNTIME_DIR=${fixture.scope.runtimeDir}`);
    expect(args).toContain(fixture.scope.entrypoint);
    expect(args).toContain("daemon");
    expect(args).toContain("start");
    expect(args).toContain("--foreground");
    expect(args.slice(-4)).toEqual([
      DAEMON_TEST_OWNER_OPTION,
      fixture.scope.ownerId,
      DAEMON_TEST_ENTRYPOINT_OPTION,
      fixture.scope.entrypoint,
    ]);
    expect(JSON.stringify(args)).not.toContain("scope-secret");
    expect(JSON.stringify(args)).not.toContain("LCM_DATABASE_PATH");
    expect(options.env.HOME).toBe(fixture.scope.homeDir);
    expect(options.env.USERPROFILE).toBe(fixture.scope.homeDir);
    expect(options.env.XDG_RUNTIME_DIR).toBe(process.env.XDG_RUNTIME_DIR);
    expect(options.env.DBUS_SESSION_BUS_ADDRESS).toBe(process.env.DBUS_SESSION_BUS_ADDRESS);
    expect(options.env.LCM_DAEMON_OWNER_ID).toBe(fixture.scope.ownerId);
    expect(options.env.LCM_DATABASE_PATH).toBeUndefined();
    expect(options.env.LCM_SUMMARY_API_KEY).toBeUndefined();
    expect(fixture.stopUnit).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^lcm-daemon-[a-f0-9]{20}\.service$/u));
    expect(existsSync(fixture.scope.stateDir)).toBe(false);
    expect(existsSync(fixture.scope.runtimeDir)).toBe(false);
    expect(existsSync(fixture.scope.credentialDir)).toBe(false);
  });

  it("revalidates and preserves an existing owned token before startup", async () => {
    const fixture = createFixture("owned-existing-token");
    writeFileSync(fixture.tokenPath, "existing-token", { mode: 0o640 });
    await expect(ensureDaemon(scopedOptions(fixture))).resolves.toMatchObject({
      connected: false,
      spawned: true,
      startMethod: "systemd-user",
    });
    expect(fixture.runSystemd).toHaveBeenCalledOnce();
    expect(fixture.stopUnit).toHaveBeenCalledOnce();
    expect(existsSync(fixture.scope.stateDir)).toBe(false);
  });

  it("refuses detached fallback after a manager operation fails", async () => {
    const fixture = createFixture("owned-failure");
    fixture.runSystemd.mockReturnValue({ status: 1, stdout: "", stderr: "failed" });
    const result = await ensureDaemon(scopedOptions(fixture));
    expect(result).toMatchObject({ connected: false, spawned: false, refusalReason: "startup-failure" });
    expect(fixture.stopUnit).not.toHaveBeenCalled();
    expect(fixture.spawnProcess).not.toHaveBeenCalled();
    expect(existsSync(fixture.scope.stateDir)).toBe(false);
  });

  it("cleans on a health timeout", async () => {
    let postStartHealthProbe = false;
    const fetch = vi.fn(async () => {
      postStartHealthProbe = fetch.mock.calls.length > 1;
      throw new Error("offline");
    });
    const fixture = createFixture("owned-timeout", { fetch: fetch as never });
    const result = await ensureDaemon({
      ...scopedOptions(fixture),
      spawnTimeoutMs: 3,
      _skipHealthWait: false,
      _monotonicNowOverride: () => postStartHealthProbe ? 3 : 0,
    });
    expect(result).toMatchObject({
      connected: false,
      spawned: true,
      refusalReason: "startup-failure",
      startMethod: "systemd-user",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fixture.supervisor.start).toHaveBeenCalledOnce();
    const startedUnit = (fixture.supervisor.start.mock.calls[0]?.[0] as { name?: unknown } | undefined)?.name;
    expect(startedUnit).toEqual(expect.stringMatching(/^lcm-daemon-[a-f0-9]{20}\.service$/u));
    expect(fixture.supervisor.stopAndAwaitAbsent).toHaveBeenCalledOnce();
    expect(fixture.stopUnit).toHaveBeenCalledExactlyOnceWith(startedUnit);
    expect(existsSync(fixture.scope.stateDir)).toBe(false);
    expect(existsSync(fixture.scope.runtimeDir)).toBe(false);
    expect(existsSync(fixture.scope.credentialDir)).toBe(false);
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

  it("rechecks interruption after the initial probe before token or startup effects", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => {
      controller.abort();
      throw new Error("initial probe interrupted");
    });
    const fixture = createFixture("owned-probe-interrupt", {
      fetch: fetch as never,
    });
    await expect(ensureDaemon({
      ...scopedOptions(fixture),
      _abortSignal: controller.signal,
    })).resolves.toMatchObject({
      connected: false,
      spawned: false,
      warning: "daemon lifecycle was interrupted before startup",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(existsSync(fixture.pidPath)).toBe(false);
    expect(existsSync(fixture.tokenPath)).toBe(false);
    expect(fixture.runSystemd).not.toHaveBeenCalled();
    expect(fixture.spawnProcess).not.toHaveBeenCalled();
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.stopUnit).not.toHaveBeenCalled();
  });

  it("observes abort cleanup rejection until finish awaits it", async () => {
    const controller = new AbortController();
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error("initially offline"))
      .mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
    const fixture = createFixture("owned-rejecting-cleanup", {
      fetch: fetch as never,
    });
    fixture.supervisor.stopAndAwaitAbsent.mockRejectedValue(new Error("stop failed"));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const operation = ensureDaemon({
        ...scopedOptions(fixture),
        spawnTimeoutMs: 500,
        _skipHealthWait: false,
        _abortSignal: controller.signal,
      });
      await vi.waitFor(() => expect(fixture.runSystemd).toHaveBeenCalledOnce());
      controller.abort();
      await expect(operation).rejects.toThrow("stop failed");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fixture.supervisor.stopAndAwaitAbsent).toHaveBeenCalledOnce();
      expect(fixture.killProcess).not.toHaveBeenCalled();
      expect(existsSync(fixture.scope.stateDir)).toBe(false);
      expect(existsSync(fixture.scope.runtimeDir)).toBe(false);
      expect(existsSync(fixture.scope.credentialDir)).toBe(false);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("cleans when interrupted during transient-unit startup", async () => {
    const controller = new AbortController();
    const fixture = createFixture("owned-startup-interrupt");
    let started = false;
    fixture.supervisor.probe.mockImplementation(async (spec: { scopeDigest: string; nonce: string; name: string }) => started
      ? { kind: "registered-running-valid", managerPid: 42_424, scopeDigest: spec.scopeDigest, nonce: spec.nonce, name: spec.name }
      : { kind: "absent", name: spec.name });
    fixture.supervisor.start.mockImplementation(async (spec: { scopeDigest: string; nonce: string; name: string }) => {
      started = true;
      controller.abort();
      return { kind: "systemd-user", name: spec.name, scopeDigest: spec.scopeDigest, nonce: spec.nonce, port: 48_321, managerPid: 42_424 };
    });
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

  it("blocks an unauthenticated foreign retry before parent repair can signal it", async () => {
    const fixture = createFixture("retry-foreign-owner");
    const foreign = createFixture("retry-foreign-scope");
    const daemonPid = 5252;
    const managerPid = 6262;
    writeFileSync(fixture.pidPath, String(daemonPid));
    ensureAuthToken(fixture.tokenPath);
    const procRoot = join(fixture.root, "proc");
    mkdirSync(join(procRoot, String(daemonPid)), { recursive: true });
    mkdirSync(join(procRoot, String(managerPid)), { recursive: true });
    writeFileSync(
      join(procRoot, String(daemonPid), "status"),
      `Name:\tlcm\nUid:\t1000\t1000\t1000\t1000\nPPid:\t${managerPid}\n`,
    );
    writeFileSync(
      join(procRoot, String(daemonPid), "cmdline"),
      "node\0lcm\0daemon\0start\0",
    );
    writeFileSync(
      join(procRoot, String(managerPid), "status"),
      "Name:\tsystemd\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n",
    );
    writeFileSync(
      join(procRoot, String(managerPid), "cmdline"),
      "systemd\0--user\0",
    );
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error("initially down"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "ok",
          version: "1.4.2",
          storageBackend: "sqlite",
          pid: daemonPid,
          ownerId: foreign.scope.ownerId,
          entrypoint: foreign.scope.entrypoint,
        }),
      });
    const scope = createDaemonLifecycleTestScope({
      ...fixture.scope,
      dependencies: {
        ...fixture.scope.dependencies,
        fetch: fetch as never,
        isProcessAlive: () => true,
      },
    });
    await expect(ensureDaemon({
      ...scopedOptions(fixture),
      _testScope: scope,
      _procRoot: procRoot,
      _uid: 1000,
      _listeningPortsOverride: () => [48_321],
    })).resolves.toMatchObject({
      connected: false,
      spawned: false,
      refusalReason: "invalid-collision",
      warning: expect.stringContaining("live PID owns its state"),
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(existsSync(fixture.pidPath)).toBe(true);
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.stopUnit).not.toHaveBeenCalled();
    expect(fixture.runSystemd).not.toHaveBeenCalled();
    expect(fixture.spawnProcess).not.toHaveBeenCalled();
  });

  it("treats an empty owned token as unavailable without leaving its scope", async () => {
    const fixture = createFixture("owned-empty-token");
    writeFileSync(fixture.pidPath, "5152");
    writeFileSync(fixture.tokenPath, "");
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        version: "1.4.2",
        storageBackend: "sqlite",
        pid: 5152,
        ownerId: fixture.scope.ownerId,
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
    await expect(ensureDaemon({
      ...scopedOptions(fixture),
      _testScope: scope,
      _skipSpawn: true,
      _listeningPortsOverride: () => [48_321],
    })).resolves.toMatchObject({ connected: false, spawned: false });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.stopUnit).not.toHaveBeenCalled();
  });

  it("treats a missing owned token as unavailable without leaving its scope", async () => {
    const fixture = createFixture("owned-missing-token");
    writeFileSync(fixture.pidPath, "5155");
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        version: "1.4.2",
        storageBackend: "sqlite",
        pid: 5155,
        ownerId: fixture.scope.ownerId,
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
    await expect(ensureDaemon({
      ...scopedOptions(fixture),
      _testScope: scope,
      _skipSpawn: true,
      _listeningPortsOverride: () => [48_321],
    })).resolves.toMatchObject({ connected: false, spawned: false });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.stopUnit).not.toHaveBeenCalled();
  });

  it("refuses a token leaf swap before startup token access", async () => {
    const fixture = createFixture("swap-token-startup");
    const spawnArgs = [fixture.scope.entrypoint, "daemon", "start", "--foreground"];
    Object.defineProperty(spawnArgs, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        mkdirSync(fixture.tokenPath);
        return fixture.scope.entrypoint;
      },
    });
    await expect(ensureDaemon({
      ...scopedOptions(fixture),
      spawnArgs,
    })).resolves.toMatchObject({
      connected: false,
      spawned: false,
      refusalReason: "invalid-collision",
    });
    expect(existsSync(fixture.tokenPath)).toBe(true);
    expect(readdirSync(fixture.tokenPath)).toEqual([]);
    expect(fixture.runSystemd).not.toHaveBeenCalled();
    expect(fixture.spawnProcess).not.toHaveBeenCalled();
    expect(fixture.killProcess).not.toHaveBeenCalled();
  });

  it("refuses a token leaf swap after PID identity without accessing the replacement", async () => {
    const fixture = createFixture("swap-token-after-pid");
    writeFileSync(fixture.pidPath, "5153");
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        version: "1.4.2",
        storageBackend: "sqlite",
        pid: 5153,
        ownerId: fixture.scope.ownerId,
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
    const listeningPorts = vi.fn(() => {
      mkdirSync(fixture.tokenPath);
      return [48_321];
    });
    await expect(ensureDaemon({
      ...scopedOptions(fixture),
      _testScope: scope,
      _skipSpawn: true,
      _listeningPortsOverride: listeningPorts,
    })).resolves.toMatchObject({
      connected: false,
      spawned: false,
      refusalReason: "invalid-collision",
    });
    expect(listeningPorts).not.toHaveBeenCalled();
    expect(existsSync(fixture.tokenPath)).toBe(false);
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.stopUnit).not.toHaveBeenCalled();
  });

  it("refuses a scoped state swap before stale-PID recovery", async () => {
    const fixture = createFixture("swap-stale-pid");
    writeFileSync(fixture.pidPath, "5154");
    const targetRoot = mkdtempSync(join(tmpdir(), "lcm-lifecycle-stale-target-"));
    roots.push(targetRoot);
    writeFileSync(join(targetRoot, "daemon.pid"), "9194", { mode: 0o640 });
    let swapped = false;
    const scope = createDaemonLifecycleTestScope({
      ...fixture.scope,
      dependencies: {
        ...fixture.scope.dependencies,
        isProcessAlive: () => true,
        sleep: async () => {
          if (swapped) return;
          swapped = true;
          rmSync(fixture.scope.stateDir, { recursive: true, force: true });
          symlinkSync(targetRoot, fixture.scope.stateDir, "dir");
        },
      },
    });
    await expect(ensureDaemon({
      ...scopedOptions(fixture),
      _testScope: scope,
      _skipSpawn: true,
    })).resolves.toMatchObject({
      connected: false,
      spawned: false,
      refusalReason: "invalid-collision",
    });
    expect(readFileSync(join(targetRoot, "daemon.pid"), "utf-8")).toBe("9194");
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.stopUnit).not.toHaveBeenCalled();
  });

  it("refuses a state-root swap during health discovery before PID or token access", async () => {
    const fixture = createFixture("swap-health");
    writeFileSync(fixture.pidPath, "5151");
    ensureAuthToken(fixture.tokenPath);
    const targetRoot = mkdtempSync(join(tmpdir(), "lcm-lifecycle-health-target-"));
    roots.push(targetRoot);
    writeFileSync(join(targetRoot, "daemon.pid"), "9191", { mode: 0o640 });
    writeFileSync(join(targetRoot, "daemon.token"), "target-secret", { mode: 0o640 });
    const swapState = (): void => {
      rmSync(fixture.scope.stateDir, { recursive: true, force: true });
      symlinkSync(targetRoot, fixture.scope.stateDir, "dir");
    };
    const fetch = vi.fn(async () => {
      swapState();
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "ok",
          version: "1.4.2",
          storageBackend: "sqlite",
          pid: 5151,
          ownerId: fixture.scope.ownerId,
        }),
      };
    });
    const scope = createDaemonLifecycleTestScope({
      ...fixture.scope,
      dependencies: {
        ...fixture.scope.dependencies,
        fetch: fetch as never,
        isProcessAlive: () => true,
      },
    });
    await expect(ensureDaemon({
      ...scopedOptions(fixture),
      _testScope: scope,
      _skipSpawn: true,
      _listeningPortsOverride: () => [48_321],
    })).resolves.toMatchObject({
      connected: false,
      spawned: false,
      refusalReason: "invalid-collision",
    });
    expect(readFileSync(join(targetRoot, "daemon.pid"), "utf-8")).toBe("9191");
    expect(readFileSync(join(targetRoot, "daemon.token"), "utf-8")).toBe("target-secret");
    expect(statSync(join(targetRoot, "daemon.pid")).mode & 0o777).toBe(0o640);
    expect(statSync(join(targetRoot, "daemon.token")).mode & 0o777).toBe(0o640);
    expect(fixture.runSystemd).not.toHaveBeenCalled();
    expect(fixture.spawnProcess).not.toHaveBeenCalled();
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.stopUnit).not.toHaveBeenCalled();
  });

  it("revalidates state after restart validation before access or replacement", async () => {
    const fixture = createFixture("swap-restart-validator");
    const targetRoot = mkdtempSync(join(tmpdir(), "lcm-lifecycle-restart-target-"));
    roots.push(targetRoot);
    writeFileSync(join(targetRoot, "daemon.pid"), "9292", { mode: 0o640 });
    writeFileSync(join(targetRoot, "daemon.token"), "target-secret", { mode: 0o640 });
    const replacement = vi.fn();
    const validateBeforeRestart = vi.fn(() => {
      rmSync(fixture.scope.stateDir, { recursive: true, force: true });
      symlinkSync(targetRoot, fixture.scope.stateDir, "dir");
    });
    await expect(restartDaemon({
      ...scopedOptions(fixture),
      validateBeforeRestart,
      _ensureDaemonOverride: replacement,
    })).resolves.toMatchObject({
      connected: false,
      restarted: false,
      warning: expect.stringContaining("changed during restart validation"),
    });
    expect(validateBeforeRestart).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
    expect(readFileSync(join(targetRoot, "daemon.pid"), "utf-8")).toBe("9292");
    expect(readFileSync(join(targetRoot, "daemon.token"), "utf-8")).toBe("target-secret");
    expect(fixture.scope.dependencies.fetch).not.toHaveBeenCalled();
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.stopUnit).not.toHaveBeenCalled();
  });

  it("refuses cleanup after an owned root is replaced with a symlink", async () => {
    const fixture = createFixture("swap-cleanup");
    const targetRoot = mkdtempSync(join(tmpdir(), "lcm-lifecycle-cleanup-target-"));
    roots.push(targetRoot);
    writeFileSync(join(targetRoot, "daemon.pid"), "9393", { mode: 0o640 });
    writeFileSync(join(targetRoot, "daemon.token"), "target-secret", { mode: 0o640 });
    const stopUnit = vi.fn(async () => {
      rmSync(fixture.scope.stateDir, { recursive: true, force: true });
      symlinkSync(targetRoot, fixture.scope.stateDir, "dir");
    });
    const scope = createDaemonLifecycleTestScope({
      ...fixture.scope,
      dependencies: {
        ...fixture.scope.dependencies,
        stopUnit,
      },
    });
    fixture.supervisor.stopAndAwaitAbsent.mockImplementation(async (spec: { name: string }) => stopUnit(spec.name));
    await expect(ensureDaemon({
      ...scopedOptions(fixture),
      _testScope: scope,
    })).rejects.toThrow("daemon lifecycle cleanup failed");
    expect(stopUnit).toHaveBeenCalledOnce();
    expect(readFileSync(join(targetRoot, "daemon.pid"), "utf-8")).toBe("9393");
    expect(readFileSync(join(targetRoot, "daemon.token"), "utf-8")).toBe("target-secret");
    expect(statSync(join(targetRoot, "daemon.pid")).mode & 0o777).toBe(0o640);
    expect(statSync(join(targetRoot, "daemon.token")).mode & 0o777).toBe(0o640);
  });

  it("attempts every later exact cleanup stage after independent earlier failures", async () => {
    const fixture = createFixture("cleanup-all-stages");
    const targetRoot = mkdtempSync(join(tmpdir(), "lcm-lifecycle-stage-target-"));
    roots.push(targetRoot);
    const pidTarget = join(targetRoot, "host.pid");
    const tokenTarget = join(targetRoot, "host.token");
    const entrypointLink = join(targetRoot, "host-entrypoint.mjs");
    const credentialTarget = join(targetRoot, "host-credentials");
    writeFileSync(pidTarget, "8282", { mode: 0o640 });
    mkdirSync(credentialTarget);
    writeFileSync(join(credentialTarget, "sentinel"), "credential-target", {
      mode: 0o640,
    });

    const stopUnit = vi.fn(async () => {
      rmSync(fixture.pidPath, { force: true });
      ensureAuthToken(fixture.tokenPath);
      linkSync(pidTarget, fixture.pidPath);
      linkSync(fixture.tokenPath, tokenTarget);
      linkSync(fixture.scope.entrypoint, entrypointLink);
      rmSync(fixture.scope.credentialDir, { recursive: true, force: true });
      symlinkSync(credentialTarget, fixture.scope.credentialDir, "dir");
    });
    const scope = createDaemonLifecycleTestScope({
      ...fixture.scope,
      dependencies: {
        ...fixture.scope.dependencies,
        stopUnit,
      },
    });
    fixture.supervisor.stopAndAwaitAbsent.mockImplementation(async (spec: { name: string }) => stopUnit(spec.name));

    const previousSummaryApiKey = process.env.LCM_SUMMARY_API_KEY;
    process.env.LCM_SUMMARY_API_KEY = "cleanup-stage-credential";
    let failure: unknown;
    try {
      await ensureDaemon({
        ...scopedOptions(fixture),
        _testScope: scope,
      });
    } catch (error) {
      failure = error;
    } finally {
      if (previousSummaryApiKey === undefined) {
        delete process.env.LCM_SUMMARY_API_KEY;
      } else {
        process.env.LCM_SUMMARY_API_KEY = previousSummaryApiKey;
      }
    }
    expect(failure).toBeInstanceOf(AggregateError);
    const flattenMessages = (error: unknown): string[] => error instanceof AggregateError
      ? error.errors.flatMap(flattenMessages)
      : [error instanceof Error ? error.message : String(error)];
    const messages = flattenMessages(failure);
    expect(messages.filter(message => message.includes(
      "state paths changed or escaped",
    ))).toHaveLength(1);
    expect(messages).toContain(
      `lifecycle test cleanup root is not current owned state: ${fixture.scope.runtimeDir}`,
    );
    expect(messages).toContain(
      `lifecycle test cleanup root is not current owned state: ${fixture.scope.credentialDir}`,
    );

    expect(stopUnit).toHaveBeenCalledOnce();
    expect(existsSync(fixture.scope.stateDir)).toBe(false);
    expect(existsSync(fixture.scope.runtimeDir)).toBe(true);
    expect(existsSync(fixture.scope.credentialDir)).toBe(true);
    expect(readFileSync(pidTarget, "utf-8")).toBe("8282");
    expect(statSync(pidTarget).mode & 0o777).toBe(0o640);
    expect(readFileSync(tokenTarget, "utf-8").trim()).not.toBe("");
    expect(statSync(tokenTarget).mode & 0o777).toBe(0o600);
    expect(readFileSync(entrypointLink, "utf-8")).toContain("setTimeout");
    expect(readFileSync(join(credentialTarget, "sentinel"), "utf-8"))
      .toBe("credential-target");
    expect(statSync(join(credentialTarget, "sentinel")).mode & 0o777).toBe(0o640);
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
    expect(leftUnit).toMatch(/^--unit=lcm-daemon-[0-9a-f]{20}\.service$/);
    expect(rightUnit).toMatch(/^--unit=lcm-daemon-[0-9a-f]{20}\.service$/);
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
      warning: expect.stringContaining("canonical owned state"),
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

  it("rejects a restart PID boundary before validation, token, or lifecycle access", async () => {
    const fixture = createFixture("scope-boundary-restart");
    const escapedTokenPath = join(dirname(fixture.scope.stateDir), "daemon.token");
    writeFileSync(escapedTokenPath, "boundary-token", { mode: 0o644 });
    const tokenBefore = readFileSync(escapedTokenPath, "utf8");
    const tokenModeBefore = statSync(escapedTokenPath).mode & 0o777;
    const stateBefore = readdirSync(fixture.scope.stateDir);
    const validateBeforeRestart = vi.fn();
    const replacement = vi.fn();
    await expect(restartDaemon({
      ...scopedOptions(fixture),
      pidFilePath: fixture.scope.stateDir,
      validateBeforeRestart,
      _ensureDaemonOverride: replacement,
    })).resolves.toMatchObject({
      connected: false,
      spawned: false,
      restarted: false,
      warning: expect.stringContaining("canonical owned state"),
    });
    expect(readFileSync(escapedTokenPath, "utf8")).toBe(tokenBefore);
    expect(statSync(escapedTokenPath).mode & 0o777).toBe(tokenModeBefore);
    expect(readdirSync(fixture.scope.stateDir)).toEqual(stateBefore);
    expect(validateBeforeRestart).not.toHaveBeenCalled();
    expect(replacement).not.toHaveBeenCalled();
    expect(fixture.scope.dependencies.fetch).not.toHaveBeenCalled();
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.runSystemd).not.toHaveBeenCalled();
    expect(fixture.spawnProcess).not.toHaveBeenCalled();
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
    })).resolves.toMatchObject({
      restarted: false,
      refusalReason: "not-running",
      warning: expect.stringContaining("PID state is live"),
    });
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
    fixture.runSystemd.mockImplementation((command: string) => command === "/bin/ps"
      ? { status: 0, stdout: "node lcm daemon start --foreground\n", stderr: "" }
      : { status: 0, stdout: "", stderr: "" });
    await expect(restartDaemon({
      ...scopedOptions(fixture),
      _testScope: scope,
      _platform: "darwin",
      enforceUserManagerParent: false,
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

  it("revalidates the owned PID immediately before restart signaling", async () => {
    const fixture = createFixture("restart-pid-swap");
    writeFileSync(fixture.pidPath, "7374");
    const isManaged = vi.fn(async () => {
      writeFileSync(fixture.pidPath, "8374");
      return true;
    });
    await expect(restartDaemon({
      ...scopedOptions(fixture),
      enforceUserManagerParent: false,
      _isManagedProcessOverride: isManaged,
    })).rejects.toThrow("PID changed before restart signaling");
    expect(isManaged).toHaveBeenCalledExactlyOnceWith(7374);
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(readFileSync(fixture.pidPath, "utf-8")).toBe("8374");
  });

  it("does not signal or replace after managed verification is interrupted", async () => {
    const fixture = createFixture("restart-managed-abort");
    writeFileSync(fixture.pidPath, "7473", { mode: 0o640 });
    const stateBefore = readdirSync(fixture.scope.stateDir);
    const pidBefore = readFileSync(fixture.pidPath, "utf-8");
    const modeBefore = statSync(fixture.pidPath).mode & 0o777;
    const controller = new AbortController();
    const isManaged = vi.fn(async () => {
      controller.abort();
      return true;
    });
    const replacement = vi.fn(async () => ({
      connected: false,
      port: 48_321,
      spawned: true,
      startMethod: "systemd-user" as const,
    }));

    await expect(restartDaemon({
      ...scopedOptions(fixture),
      enforceUserManagerParent: false,
      _abortSignal: controller.signal,
      _isManagedProcessOverride: isManaged,
      _ensureDaemonOverride: replacement,
    })).resolves.toEqual({
      connected: false,
      port: 48_321,
      spawned: false,
      restarted: false,
      warning: "daemon lifecycle was interrupted before startup",
    });
    expect(isManaged).toHaveBeenCalledExactlyOnceWith(7473);
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.spawnProcess).not.toHaveBeenCalled();
    expect(fixture.runSystemd).not.toHaveBeenCalled();
    expect(replacement).not.toHaveBeenCalled();
    expect(readdirSync(fixture.scope.stateDir)).toEqual(stateBefore);
    expect(readFileSync(fixture.pidPath, "utf-8")).toBe(pidBefore);
    expect(statSync(fixture.pidPath).mode & 0o777).toBe(modeBefore);
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
      enforceUserManagerParent: false,
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
      enforceUserManagerParent: false,
      _listeningPortsOverride: () => [48_321],
      _abortSignal: controller.signal,
    })).rejects.toThrow("not a verified LCM daemon");
    expect(interruptedFixture.scope.dependencies.fetch).not.toHaveBeenCalled();
    expect(interruptedFixture.killProcess).not.toHaveBeenCalled();

    const elapsedFixture = createFixture("restart-deadline");
    writeFileSync(elapsedFixture.pidPath, "7676");
    const monotonicNow = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValue(11);
    await expect(restartDaemon({
      ...scopedOptions(elapsedFixture),
      spawnTimeoutMs: 10,
      enforceUserManagerParent: false,
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
    const config = loadDaemonConfig("/missing", { daemon: { port: 0, idleTimeoutMs: 0 } });
    const readAuthToken = vi.fn((): string | null => "token");
    await expect(createDaemon(config, {
      tokenPath,
      _readAuthToken: readAuthToken,
    })).rejects.toThrow("Vitest worker");
    expect(readAuthToken).not.toHaveBeenCalled();
    await expect(createDaemon(config, {
      tokenPath,
      _testIdentity: { ownerId: "partial" } as never,
      _readAuthToken: readAuthToken,
    })).rejects.toThrow("incomplete or malformed");
    expect(readAuthToken).not.toHaveBeenCalled();
    readAuthToken.mockReturnValueOnce(null);
    await expect(createDaemon(config, {
      tokenPath,
      _testIdentity: {
        ownerId: "server-auth-order",
        entrypoint: join(dir, "owned-daemon.mjs"),
      },
      _readAuthToken: readAuthToken,
    })).rejects.toThrow("could not be read");
    expect(readAuthToken).toHaveBeenCalledExactlyOnceWith(tokenPath);
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
    const stateDir = join(homeDir, ".lcm");
    const credentialDir = join(homeDir, "credentials");
    const entrypoint = join(runtimeDir, "owned-daemon.mjs");
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(credentialDir, { recursive: true });
    const builtCliUrl = pathToFileURL(join(process.cwd(), "dist", "bin", "lcm.js")).href;
    writeFileSync(
      entrypoint,
      `process.env.LCM_DAEMON_OWNER_ID = ${JSON.stringify(ownerId)};\nimport { runCli } from ${JSON.stringify(builtCliUrl)};\nawait runCli(process.argv);\n`,
    );
    const daemonPort = Number(
      process.env.LCM_LIFECYCLE_DAEMON_PORT
      ?? String(40_000 + (process.pid % 20_000)),
    );
    expect(daemonPort).toBeGreaterThan(0);
    expect(daemonPort).toBeLessThanOrEqual(65_535);
    writeFileSync(join(stateDir, "config.json"), JSON.stringify({
      daemon: { port: daemonPort, idleTimeoutMs: 0 },
      llm: { provider: "disabled" },
    }));
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
      if (command === "systemd-run" || command === "systemctl") {
        const managerEnvironment = (options as { env?: NodeJS.ProcessEnv }).env;
        expect(managerEnvironment?.XDG_RUNTIME_DIR).toBe(process.env.XDG_RUNTIME_DIR);
        if (process.env.DBUS_SESSION_BUS_ADDRESS !== undefined) {
          expect(managerEnvironment?.DBUS_SESSION_BUS_ADDRESS).toBe(process.env.DBUS_SESSION_BUS_ADDRESS);
        }
        expect(managerEnvironment?.HOME).toBeUndefined();
        expect(managerEnvironment?.LCM_POSTGRES_URL).toBeUndefined();
      }
      if (command === "systemd-run") {
        const unitArg = args.find(arg => arg.startsWith("--unit="));
        if (unitArg === undefined) {
          return {
            status: 2,
            stdout: "",
            stderr: "systemd-run integration invocation did not name a unit",
          };
        }
        const requestedUnit = unitArg.slice(7);
        if (unitName !== "" && requestedUnit !== unitName) {
          return {
            status: 2,
            stdout: "",
            stderr: "systemd-run integration unit changed",
          };
        }
        unitName = requestedUnit;
      } else if (command === "systemctl") {
        const requestedUnit = args.at(-1);
        if (requestedUnit === undefined) {
          return {
            status: 2,
            stdout: "",
            stderr: "systemctl integration invocation did not name a unit",
          };
        }
        if (unitName !== "" && requestedUnit !== unitName) {
          return {
            status: 2,
            stdout: "",
            stderr: "systemctl integration unit changed",
          };
        }
        unitName = requestedUnit;
      }
      const result = spawnSync(command, args, options);
      if (result.status !== 0) {
        console.info("[lcm lifecycle systemd failure]", JSON.stringify({
          unitName,
          status: result.status,
          stdout: String(result.stdout),
          stderr: String(result.stderr),
          args,
        }));
      }
      const barrierDir = process.env.LCM_LIFECYCLE_SYSTEMD_BARRIER_DIR;
      const expectedScopes = Number(process.env.LCM_LIFECYCLE_EXPECTED_SCOPES ?? "1");
      if (!shouldCollectSystemdBarrier(command, args, result.status, barrierDir)) return result;

      const pause = (): void => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      };
      let daemonPid = 0;
      let token = "";
      let execStart = "";
      for (let attempt = 0; attempt < 500; attempt++) {
        const status = spawnSync(
          "systemctl",
          ["--user", "show", unitName, "--property=ActiveState,MainPID,ExecStart"],
          { encoding: "utf-8", timeout: 10_000 },
        );
        const details = String(status.stdout);
        const pidMatch = /^MainPID=([0-9]+)$/mu.exec(details);
        if (
          status.status === 0
          && details.includes("ActiveState=active")
          && pidMatch
          && Number(pidMatch[1]) > 0
          && existsSync(join(stateDir, "daemon.pid"))
          && existsSync(join(stateDir, "daemon.token"))
        ) {
          daemonPid = Number(pidMatch[1]);
          token = readFileSync(join(stateDir, "daemon.token"), "utf-8").trim();
          execStart = /^ExecStart=(.*)$/mu.exec(details)?.[1] ?? "";
          break;
        }
        pause();
      }
      expect(daemonPid).toBeGreaterThan(0);
      expect(readFileSync(join(stateDir, "daemon.pid"), "utf-8").trim()).toBe(String(daemonPid));
      expect(token.length).toBeGreaterThan(0);
      expect(execStart).toContain(entrypoint);
      mkdirSync(barrierDir, { recursive: true });
      // Every real run-owned unit writes its exact .ready marker even when it
      // is the only expected scope, so the protected workflow's EXIT trap can
      // prove one exact unit for this run from marker evidence alone.
      writeFileSync(join(barrierDir, `${ownerId}.ready`), JSON.stringify({
        unitName,
        homeDir,
        runtimeDir,
        stateDir,
        credentialDir,
        entrypoint,
        daemonPid,
      }));
      // Preserve the multi-scope barrier: cross-scope uniqueness assertions
      // apply only when the workflow launches more than one run-owned scope.
      if (expectedScopes <= 1) return result;
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
      const ownership = ready.map(marker => JSON.parse(
        readFileSync(join(barrierDir, marker), "utf-8"),
      ) as {
        unitName: string;
        homeDir: string;
        runtimeDir: string;
        stateDir: string;
        credentialDir: string;
        entrypoint: string;
        daemonPid: number;
      });
      for (const key of [
        "unitName",
        "homeDir",
        "runtimeDir",
        "stateDir",
        "credentialDir",
        "entrypoint",
        "daemonPid",
      ] as const) {
        expect(new Set(ownership.map(resource => resource[key])).size).toBe(expectedScopes);
      }
      for (const resource of ownership) {
        expect(resource.unitName).toMatch(/^lcm-daemon-[a-f0-9]{20}\.service$/u);
        expect(resource.stateDir).toBe(join(resource.homeDir, ".lcm"));
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
    const savedManagedCredentials = Object.fromEntries(
      MANAGED_CREDENTIAL_NAMES.map(name => [name, process.env[name]]),
    );
    for (const name of MANAGED_CREDENTIAL_NAMES) delete process.env[name];
    let result: Awaited<ReturnType<typeof ensureDaemon>>;
    try {
      result = await ensureDaemon({
        port: daemonPort,
        pidFilePath: join(stateDir, "daemon.pid"),
        spawnTimeoutMs: 10_000,
        expectedVersion: "1.4.2",
        enforceUserManagerParent: true,
        spawnCommand: process.execPath,
        _platform: "linux",
        _testScope: scope,
        _skipHealthWait: true,
      });
    } finally {
      for (const name of MANAGED_CREDENTIAL_NAMES) {
        const value = savedManagedCredentials[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    expect(result.startMethod).toBe("systemd-user");
    expect(result.warning).toBeUndefined();
    expect(unitName).toMatch(/^lcm-daemon-[a-f0-9]{20}\.service$/u);
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
