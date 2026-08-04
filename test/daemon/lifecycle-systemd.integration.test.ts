import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSupervisor,
  createSupervisorSpec,
  type Supervisor,
  type SupervisorDependencies,
  type SupervisorObservation,
  type SupervisorSpec,
} from "../../src/daemon/supervisor.js";

type ManagerCall = Readonly<{
  command: string;
  args: readonly string[];
}>;

type SystemdFixture = Readonly<{
  root: string;
  port: number;
  wedgePath: string;
  spec: SupervisorSpec;
  supervisor: Supervisor;
  calls: ManagerCall[];
  markerPath?: string;
}>;

const integrationEnabled = process.env.LCM_LIFECYCLE_SYSTEMD_INTEGRATION === "1";
const fixtureRoots = new Set<string>();
let nonceCounter = 0;

const CHILD_SOURCE = `
import { createServer } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const port = Number(process.env.LCM_SUPERVISOR_PORT);
const stateRoot = process.env.LCM_SUPERVISOR_STATE_ROOT;
const scope = process.env.LCM_SUPERVISOR_SCOPE;
const nonce = process.env.LCM_SUPERVISOR_NONCE;
const wedgePath = argument("--wedge-file");
const exitAfter = Number(argument("--exit-after") ?? "0");
if (!Number.isInteger(port) || port < 1 || stateRoot === undefined || scope === undefined || nonce === undefined) {
  throw new Error("invalid systemd integration child metadata");
}
mkdirSync(stateRoot, { recursive: true });
writeFileSync(join(stateRoot, "daemon.pid"), String(process.pid));
writeFileSync(join(stateRoot, "daemon.token"), "systemd-integration-token\\n", { mode: 0o600 });
const server = createServer((request, response) => {
  if (request.url === "/health") {
    if (wedgePath !== undefined && existsSync(wedgePath)) return;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      status: "ok",
      version: "1.4.2",
      storageBackend: "sqlite",
      pid: process.pid,
      entrypoint: process.argv[1],
      scope,
      stateRoot,
      nonce,
      port,
    }));
    return;
  }
  if (request.url === "/stats/pool") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ totalConnections: 0 }));
    return;
  }
  response.statusCode = 404;
  response.end();
});
server.listen(port, "127.0.0.1");
if (exitAfter > 0) {
  setTimeout(() => server.close(() => process.exit(0)), exitAfter);
}
`;

afterEach(async () => {
  // Each test also performs exact manager cleanup in its own finally block.
  // Keep this fallback limited to the roots created by this file so a failed
  // assertion cannot leave a test child running without touching foreign jobs.
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
  fixtureRoots.clear();
});

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      if (port === undefined) {
        server.close(() => reject(new Error("systemd integration port was not allocated")));
        return;
      }
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve(port);
      });
    });
  });
}

function runManager(
  calls: ManagerCall[],
): SupervisorDependencies["run"] {
  return (command, args, options) => {
    calls.push(Object.freeze({ command, args: [...args] }));
    const result = spawnSync(command, [...args], {
      encoding: "utf-8",
      timeout: options.timeoutMs,
      cwd: options.cwd,
      env: options.env === undefined ? process.env : options.env,
      shell: false,
    });
    const error = result.error as NodeJS.ErrnoException | undefined;
    return {
      code: result.status,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      timedOut: error?.code === "ETIMEDOUT",
    };
  };
}

async function createFixture(options: { exitAfterMs?: number } = {}): Promise<SystemdFixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lcm-systemd-real-")));
  fixtureRoots.add(root);
  const entrypoint = join(root, "child.mjs");
  const wedgePath = join(root, "wedge");
  const port = await allocatePort();
  const exitAfterMs = options.exitAfterMs ?? 0;
  writeFileSync(entrypoint, CHILD_SOURCE, { mode: 0o700 });
  const environment = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    LCM_POSTGRES_URL: undefined,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
  };
  const nonce = `systemd-integration-${process.pid}-${nonceCounter++}`;
  const args = [
    entrypoint,
    "--wedge-file",
    wedgePath,
    "--exit-after",
    String(exitAfterMs),
  ];
  const spec = createSupervisorSpec({
    kind: "systemd-user",
    stateRoot: root,
    port,
    nonce,
    executable: process.execPath,
    args,
    cwd: root,
    entrypoint,
    launchEnvironment: environment,
    stopTimeoutMs: 5_000,
  });
  const barrierDir = process.env.LCM_LIFECYCLE_SYSTEMD_BARRIER_DIR;
  const markerPath = barrierDir === undefined
    ? undefined
    : (() => {
        mkdirSync(barrierDir, { recursive: true });
        const path = join(barrierDir, `${spec.scopeDigest}.ready`);
        writeFileSync(path, JSON.stringify({
          unitName: spec.systemdUnit,
          stateRoot: root,
        }));
        return path;
      })();
  const calls: ManagerCall[] = [];
  const supervisor = createSupervisor("systemd-user", {
    run: runManager(calls),
    environment,
    platform: "linux",
    commandTimeoutMs: 5_000,
    stopTimeoutMs: 5_000,
    sleep: wait,
  });
  return { root, port, wedgePath, spec, supervisor, calls, markerPath };
}

async function cleanupFixture(fixture: SystemdFixture): Promise<void> {
  let managerAbsent = false;
  try {
    await fixture.supervisor.stopAndAwaitAbsent(fixture.spec);
    managerAbsent = true;
  } catch {
    // Preserve the primary assertion; the exact unit remains bounded to this
    // fixture root and is never addressed through a broad process signal.
  }
  if (managerAbsent && fixture.markerPath !== undefined) rmSync(fixture.markerPath, { force: true });
  fixtureRoots.delete(fixture.root);
  rmSync(fixture.root, { recursive: true, force: true });
}

async function waitForHealth(
  fixture: SystemdFixture,
  managerPid: number,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${fixture.port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.status === 200) {
        const body = await response.json() as unknown;
        if (
          typeof body === "object"
          && body !== null
          && (body as Record<string, unknown>).status === "ok"
          && (body as Record<string, unknown>).pid === managerPid
          && (body as Record<string, unknown>).scope === fixture.spec.scopeDigest
          && (body as Record<string, unknown>).stateRoot === fixture.spec.stateRoot
          && (body as Record<string, unknown>).nonce === fixture.spec.nonce
          && (body as Record<string, unknown>).port === fixture.port
        ) return body as Record<string, unknown>;
      }
    } catch {
      // The transient unit may still be between submission and listen().
    }
    await wait(50);
  }
  throw new Error(`systemd integration health did not become exact for ${fixture.spec.name}`);
}

async function waitForTerminal(
  fixture: SystemdFixture,
): Promise<Extract<SupervisorObservation, { kind: "registered-not-running-valid" }> | Extract<SupervisorObservation, { kind: "absent" }>> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const observed = await fixture.supervisor.probe(fixture.spec);
    if (observed.kind === "registered-not-running-valid" || observed.kind === "absent") return observed;
    await wait(50);
  }
  throw new Error("systemd integration child did not reach a terminal or absent state");
}

const linuxSystemd = process.platform === "linux" && integrationEnabled ? it : it.skip;

describe("real user-systemd daemon lifecycle", () => {
  linuxSystemd("starts and admits a healthy managed unit with exact identity and cleanup", { timeout: 60_000 }, async () => {
    const fixture = await createFixture();
    try {
      const started = await fixture.supervisor.start(fixture.spec);
      expect(started).toMatchObject({
        kind: "systemd-user",
        name: fixture.spec.systemdUnit,
        scopeDigest: fixture.spec.scopeDigest,
        nonce: fixture.spec.nonce,
        port: fixture.port,
      });
      expect(started.managerPid).toBeGreaterThan(0);
      const health = await waitForHealth(fixture, started.managerPid!);
      expect(health.entrypoint).toBe(fixture.spec.entrypoint);
      expect(await fixture.supervisor.probe(fixture.spec)).toMatchObject({
        kind: "registered-running-valid",
        managerPid: started.managerPid,
        name: fixture.spec.name,
        scopeDigest: fixture.spec.scopeDigest,
        nonce: fixture.spec.nonce,
      });
      expect(fixture.spec.systemdUnit).toMatch(/^lcm-daemon-[0-9a-f]{20}\.service$/u);
    } finally {
      await cleanupFixture(fixture);
    }
    expect(existsSync(fixture.root)).toBe(false);
  });

  linuxSystemd("restarts a wedged registered unit through systemd without legacy signal fallback", { timeout: 60_000 }, async () => {
    const fixture = await createFixture();
    try {
      const started = await fixture.supervisor.start(fixture.spec);
      await waitForHealth(fixture, started.managerPid!);
      writeFileSync(fixture.wedgePath, "wedged\n");
      const controller = new AbortController();
      const noResponse = await Promise.race([
        fetch(`http://127.0.0.1:${fixture.port}/health`, { signal: controller.signal })
          .then(() => false)
          .catch(() => true),
        wait(500).then(() => true),
      ]);
      controller.abort();
      expect(noResponse).toBe(true);
      rmSync(fixture.wedgePath, { force: true });
      expect(await fixture.supervisor.probe(fixture.spec)).toMatchObject({
        kind: "registered-running-valid",
        managerPid: started.managerPid,
      });

      const restarted = await fixture.supervisor.stopAndStart(fixture.spec);
      expect(restarted.kind).toBe("systemd-user");
      expect(restarted.managerPid).toBeGreaterThan(0);
      await waitForHealth(fixture, restarted.managerPid!);
      expect(fixture.calls.some(call => call.command === "systemctl" && call.args.includes("stop"))).toBe(true);
      expect(fixture.calls.some(call => call.command === "systemd-run")).toBe(true);
      expect(fixture.calls.some(call => /^(?:kill|pkill|killall)$/u.test(call.command))).toBe(false);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  linuxSystemd("recreates a terminal clean-exit unit after a registered-not-running observation", { timeout: 60_000 }, async () => {
    const fixture = await createFixture({ exitAfterMs: 250 });
    try {
      const first = await fixture.supervisor.start(fixture.spec);
      expect(first.managerPid).toBeGreaterThan(0);
      const terminal = await waitForTerminal(fixture);
      expect(["absent", "registered-not-running-valid"]).toContain(terminal.kind);
      const recreated = await fixture.supervisor.start(fixture.spec);
      expect(recreated.kind).toBe("systemd-user");
      expect(recreated.managerPid).toBeGreaterThan(0);
      await waitForHealth(fixture, recreated.managerPid!);
      expect(await fixture.supervisor.probe(fixture.spec)).toMatchObject({
        kind: "registered-running-valid",
        managerPid: recreated.managerPid,
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  linuxSystemd("refuses stale manager identity before mutation and never falls back to legacy signals", { timeout: 60_000 }, async () => {
    const fixture = await createFixture();
    try {
      const started = await fixture.supervisor.start(fixture.spec);
      await waitForHealth(fixture, started.managerPid!);
      const stale = Object.freeze({ ...fixture.spec, port: fixture.port + 1 });
      const observed = await fixture.supervisor.probe(stale);
      expect(observed).toMatchObject({ kind: "registered-stale-config", name: fixture.spec.name });
      const mutationCount = fixture.calls.filter(call => call.command === "systemd-run").length;
      await expect(fixture.supervisor.start(stale)).rejects.toThrow("manager command");
      expect(fixture.calls.filter(call => call.command === "systemd-run")).toHaveLength(mutationCount);
      expect(fixture.calls.some(call => /^(?:kill|pkill|killall)$/u.test(call.command))).toBe(false);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  linuxSystemd("refuses clean-environment drift before admitting an existing unit", { timeout: 60_000 }, async () => {
    const fixture = await createFixture();
    try {
      const started = await fixture.supervisor.start(fixture.spec);
      await waitForHealth(fixture, started.managerPid!);
      const launchEnvironment = {
        ...fixture.spec.launchEnvironment,
        PATH: `${fixture.spec.launchEnvironment?.PATH ?? "/usr/bin"}:/lcm-drift`,
      };
      const drifted = createSupervisorSpec({
        kind: "systemd-user",
        stateRoot: fixture.spec.stateRoot,
        port: fixture.spec.port,
        nonce: fixture.spec.nonce,
        executable: fixture.spec.executable,
        args: fixture.spec.args,
        cwd: fixture.spec.cwd,
        entrypoint: fixture.spec.entrypoint,
        runtimeDigest: fixture.spec.runtimeDigest,
        storageBackend: fixture.spec.storageBackend,
        launchEnvironment,
        stopTimeoutMs: fixture.spec.stopTimeoutMs,
      });
      expect(await fixture.supervisor.probe(drifted)).toMatchObject({
        kind: "registered-stale-config",
        reason: "metadata-mismatch",
      });
      expect(fixture.calls.filter((call) => call.command === "systemd-run")).toHaveLength(1);
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
