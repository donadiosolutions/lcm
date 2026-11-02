import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  probe: vi.fn(),
  socket: vi.fn(),
  cgroup: "",
  hideDescriptors: true,
  nativeSupervisor: false,
  nativeRun: vi.fn(),
}));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => String(path) === "/usr/bin/ss" || actual.existsSync(path),
    readFileSync: (path: Parameters<typeof actual.readFileSync>[0], ...args: unknown[]) => {
      if (String(path) === `/proc/${process.pid}/cmdline`) return "node\0/opt/lcm.mjs\0daemon\0start\0--foreground\0";
      return Reflect.apply(actual.readFileSync, actual, [path, ...args]);
    },
    readlinkSync: (path: Parameters<typeof actual.readlinkSync>[0], ...args: unknown[]) => {
      if (state.hideDescriptors && String(path).startsWith(`/proc/${process.pid}/fd/`)) {
        throw Object.assign(new Error("namespace denies descriptor target"), { code: "EACCES" });
      }
      return Reflect.apply(actual.readlinkSync, actual, [path, ...args]);
    },
  };
});
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawnSync: (...args: unknown[]) => state.socket(...args),
}));
vi.mock("../../src/daemon/supervisor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/daemon/supervisor.js")>();
  return {
    ...actual,
    createSupervisor: vi.fn((kind, dependencies) => state.nativeSupervisor
      ? actual.createSupervisor(kind, dependencies)
      : { probe: state.probe }),
  };
});

import { verifiedLocalDaemonClient, DaemonPeerRefusalError } from "../../src/daemon/client.js";
import { admitCurrentDaemonPeer } from "../../src/daemon/peer-admission.js";
import type { SupervisorSpec } from "../../src/daemon/supervisor.js";
import { createSupervisorSpec, managedLaunchEnvironment, managedLaunchEnvironmentDigest } from "../../src/daemon/supervisor.js";
import { managedDaemonPathForStableLaunch } from "../../src/daemon/managed-path.js";
import * as auth from "../../src/daemon/auth.js";
import * as securityFiles from "../../src/security-files.js";

describe("current guarded client in a Linux sibling user namespace", () => {
  let homeDir: string;
  let server: Server;
  let port: number;
  let requests: Array<{ authorization: string | undefined; body: string }>;
  beforeEach(async () => {
    state.hideDescriptors = true;
    state.nativeSupervisor = false;
    state.nativeRun.mockReset();
    state.cgroup = "";
    homeDir = mkdtempSync(join(tmpdir(), "lcm-current-managed-peer-"));
    mkdirSync(join(homeDir, ".lcm"), { mode: 0o700 });
    writeFileSync(join(homeDir, ".lcm", "daemon.pid"), String(process.pid), { mode: 0o600 });
    writeFileSync(join(homeDir, ".lcm", "daemon.token"), "managed-peer-token", { mode: 0o600 });
    requests = [];
    server = createServer((request, response) => {
      let body = "";
      request.on("data", chunk => { body += String(chunk); });
      request.on("end", () => {
        requests.push({ authorization: request.headers.authorization, body });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ stored: true }));
      });
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    port = (server.address() as AddressInfo).port;
    state.probe.mockReset().mockImplementation(async (spec: SupervisorSpec) => {
      state.cgroup ||= `/user.slice/user-${process.getuid!()}.slice/user@${process.getuid!()}.service/app.slice/${spec.systemdUnit}`;
      return {
        kind: spec.nonce === "peer-observation" ? "registered-stale-config" : "registered-running-valid",
        reason: "metadata-mismatch", marker: spec.marker, scopeDigest: spec.scopeDigest,
        stateRoot: spec.stateRoot, name: spec.name, port: spec.port, nonce: "managed-launch",
        executable: process.execPath, args: JSON.stringify(["/opt/lcm.mjs", "daemon", "start", "--foreground"]),
        cwd: "", managerPid: process.pid, controlGroup: state.cgroup,
      };
    });
    state.socket.mockReset().mockImplementation((command: string) => {
      if (command === "systemctl") {
        const result = state.nativeRun();
        return { ...result, status: result.code };
      }
      return {
        status: command === "/usr/bin/ss" ? 0 : 1,
        stdout: `LISTEN 0 511 127.0.0.1:${port} 0.0.0.0:* ino:123 sk:1 cgroup:${state.cgroup} <->\n`,
        stderr: "",
      };
    });
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    rmSync(homeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("sends through the default factory with hidden fd links and freshly proved manager/cgroup authority", async () => {
    const client = verifiedLocalDaemonClient(port, undefined, homeDir);
    await expect(client.post("/store", { content: "first" })).resolves.toEqual({ stored: true });
    expect(requests).toEqual([{ authorization: "Bearer managed-peer-token", body: '{"content":"first"}' }]);
    expect(state.probe).toHaveBeenCalledTimes(2);
    expect(state.socket).toHaveBeenCalledWith("/usr/bin/ss", expect.any(Array), expect.objectContaining({ timeout: expect.any(Number) }));
    const firstDeadline = state.probe.mock.calls[0]![1].deadline;
    expect(state.probe.mock.calls[1]![1].deadline).toBe(firstDeadline);
    state.probe.mockResolvedValue({ kind: "registered-running-valid", managerPid: process.pid + 1 });
    const serialize = vi.fn();
    const readToken = vi.spyOn(auth, "readAuthToken");
    await expect(client.post("/store", { toJSON: serialize })).rejects.toBeInstanceOf(DaemonPeerRefusalError);
    expect(serialize).not.toHaveBeenCalled();
    expect(readToken).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it("also admits through the real supervisor parser and environment identity, then rejects changed manager PID", async () => {
    state.nativeSupervisor = true;
    const args = ["/opt/lcm.mjs", "daemon", "start", "--foreground"];
    const environment = {
      ...managedLaunchEnvironment(process.env),
      PATH: managedDaemonPathForStableLaunch(process.execPath, args, join(homeDir, ".lcm")),
    };
    const spec = createSupervisorSpec({
      kind: "systemd-user", stateRoot: join(homeDir, ".lcm"), port, nonce: "managed-launch",
      executable: process.execPath, args, launchEnvironment: environment,
    });
    state.cgroup = `/user.slice/user-${process.getuid!()}.slice/user@${process.getuid!()}.service/app.slice/${spec.systemdUnit}`;
    const digest = managedLaunchEnvironmentDigest(spec, "systemd-user", process.getuid!(), environment);
    let managerPid = process.pid;
    state.nativeRun.mockImplementation(() => ({ code: 0, stdout: [
      "LoadState=loaded", "ActiveState=active", "SubState=running", `MainPID=${managerPid}`,
      `ControlGroup=${state.cgroup}`,
      `Environment=LCM_SUPERVISOR_MARKER=${spec.marker} LCM_SUPERVISOR_SCOPE=${spec.scopeDigest} LCM_SUPERVISOR_STATE_ROOT=${spec.stateRoot} LCM_SUPERVISOR_PORT=${port} LCM_SUPERVISOR_NONCE=${spec.nonce} LCM_SUPERVISOR_EXECUTABLE=${spec.executable} LCM_SUPERVISOR_ARGS=${JSON.stringify(args)} LCM_SUPERVISOR_CWD= LCM_SUPERVISOR_ENV_DIGEST=${digest}`,
    ].join("\n") }));
    const client = verifiedLocalDaemonClient(port, undefined, homeDir);
    await expect(client.post("/store", { content: "native parser" })).resolves.toEqual({ stored: true });
    expect(state.nativeRun).toHaveBeenCalledTimes(2);
    managerPid += 1;
    const serialize = vi.fn();
    const readToken = vi.spyOn(auth, "readAuthToken");
    await expect(client.post("/store", { toJSON: serialize })).rejects.toBeInstanceOf(DaemonPeerRefusalError);
    expect(readToken).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it("refuses a fresh manager cgroup that differs from the kernel listener before token and body", async () => {
    const original = state.probe.getMockImplementation()!;
    state.probe.mockImplementation(async (spec, options) => ({ ...await original(spec, options), controlGroup: "/foreign.service" }));
    const client = verifiedLocalDaemonClient(port, undefined, homeDir);
    const serialize = vi.fn();
    const readToken = vi.spyOn(auth, "readAuthToken");
    await expect(client.post("/store", { toJSON: serialize })).rejects.toBeInstanceOf(DaemonPeerRefusalError);
    expect(readToken).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it("does not give a current sender the replacement-only missing PID exception", async () => {
    unlinkSync(join(homeDir, ".lcm", "daemon.pid"));
    await expect(admitCurrentDaemonPeer({ port, homeDir, deadline: performance.now() + 1_000 })).resolves.toBeNull();
    expect(state.probe).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it.each([
    { kind: "absent" }, { marker: "foreign" }, { scopeDigest: "foreign" },
    { stateRoot: "/foreign" }, { name: "foreign.service" }, { port: 1 },
    { managerPid: -1 }, { nonce: undefined }, { executable: undefined }, { args: undefined },
    { args: "invalid-json" }, { args: "{}" }, { args: "[1]" },
    { args: '["unrelated"]' },
  ])("rejects incomplete or conflicting fresh manager metadata %j", async override => {
    const original = state.probe.getMockImplementation()!;
    state.probe.mockImplementation(async (spec, options) => ({ ...await original(spec, options), ...override }));
    await expect(admitCurrentDaemonPeer({ port, homeDir, deadline: performance.now() + 1_000 })).resolves.toBeNull();
    expect(requests).toEqual([]);
  });

  it.each([
    { kind: "absent" }, { managerPid: -1 }, { scopeDigest: "foreign" },
    { name: "foreign.service" }, { nonce: "changed-launch" }, { controlGroup: undefined },
  ])("rejects a changed second manager observation %j", async override => {
    const original = state.probe.getMockImplementation()!;
    state.probe.mockImplementation(async (spec, options) => ({
      ...await original(spec, options), ...(spec.nonce === "peer-observation" ? {} : override),
    }));
    await expect(admitCurrentDaemonPeer({ port, homeDir, deadline: performance.now() + 1_000 })).resolves.toBeNull();
  });

  it("retains complete observed launch metadata and deterministic native dependencies", async () => {
    const original = state.probe.getMockImplementation()!;
    state.probe.mockImplementation(async (spec, options) => ({
      ...await original(spec, options), cwd: homeDir, entrypoint: "/opt/lcm.mjs",
      runtimeDigest: "a".repeat(64), storageBackend: "postgresql", postgresCaFile: join(homeDir, "ca.pem"),
      credentialDirectory: join(homeDir, ".lcm", "credentials", "managed-launch"), credentialFiles: [],
    }));
    await expect(admitCurrentDaemonPeer({
      port, homeDir, pidFilePath: join(homeDir, ".lcm", "daemon.pid"), deadline: performance.now() + 1_000,
      _uid: process.getuid!(), _spawnSync: state.socket as never,
    })).resolves.toMatchObject({ pid: process.pid });
  });

  it("fails closed for cancelled, expired, unsupported or noncanonical current admission", async () => {
    const controller = new AbortController();
    controller.abort();
    const options = { port, homeDir, deadline: performance.now() + 1_000 };
    await expect(admitCurrentDaemonPeer({ ...options, signal: controller.signal })).resolves.toBeNull();
    await expect(admitCurrentDaemonPeer({ ...options, deadline: 0 })).resolves.toBeNull();
    await expect(admitCurrentDaemonPeer({ ...options, _platform: "win32" })).resolves.toBeNull();
    await expect(admitCurrentDaemonPeer({ ...options, pidFilePath: join(homeDir, "foreign.pid") })).resolves.toBeNull();
    vi.spyOn(process, "getuid").mockReturnValue(undefined as never);
    await expect(admitCurrentDaemonPeer(options)).resolves.toBeNull();
    expect(state.probe).not.toHaveBeenCalled();
  });

  it("does not renew a budget consumed by the first manager observation", async () => {
    let now = 0;
    const original = state.probe.getMockImplementation()!;
    state.probe.mockImplementation(async (spec, options) => {
      const value = await original(spec, options);
      now = 100;
      return value;
    });
    await expect(admitCurrentDaemonPeer({ port, homeDir, deadline: 100, now: () => now })).resolves.toBeNull();
    expect(state.probe).toHaveBeenCalledTimes(1);
  });

  it("refuses a process whose birth changes during the manager proof", async () => {
    let observations = 0;
    const birth = vi.fn(() => ++observations <= 2 ? "before" : "after");
    await expect(admitCurrentDaemonPeer({ port, homeDir, deadline: performance.now() + 1_000, _processBirth: birth })).resolves.toBeNull();
  });

  it("refuses malformed private PID evidence and missing native process birth", async () => {
    const options = { port, homeDir, deadline: performance.now() + 1_000 };
    const pidPath = join(homeDir, ".lcm", "daemon.pid");
    writeFileSync(pidPath, "001");
    await expect(admitCurrentDaemonPeer(options)).resolves.toBeNull();
    writeFileSync(pidPath, "9007199254740992");
    await expect(admitCurrentDaemonPeer(options)).resolves.toBeNull();
    writeFileSync(pidPath, String(process.pid));
    await expect(admitCurrentDaemonPeer({ ...options, _processBirth: () => null })).resolves.toBeNull();
    await expect(admitCurrentDaemonPeer({ port, deadline: performance.now() + 1_000 })).resolves.toBeNull();
    expect(state.probe).not.toHaveBeenCalled();
  });

  it("rejects replacement of the retained PID inode after the final OS attribution", async () => {
    const read = securityFiles.readBoundedRegularFileWithStat;
    let reads = 0;
    vi.spyOn(securityFiles, "readBoundedRegularFileWithStat").mockImplementation((path, options) => {
      if (++reads === 5) {
        renameSync(path, `${path}.prior`);
        writeFileSync(path, String(process.pid), { mode: 0o600 });
      }
      return read(path, options);
    });
    await expect(admitCurrentDaemonPeer({ port, homeDir, deadline: performance.now() + 1_000 })).resolves.toBeNull();
    expect(reads).toBe(5);
  });

  it("refuses a manager timeout through the bounded native command runner", async () => {
    state.nativeSupervisor = true;
    state.nativeRun.mockReturnValue({ code: null, stdout: "", stderr: "", error: { code: "ETIMEDOUT" } });
    await expect(admitCurrentDaemonPeer({
      port, homeDir, deadline: performance.now() + 1_000, _spawnSync: state.socket as never,
    })).resolves.toBeNull();
  });

  it("does not launch a manager command after its remaining deadline expires", async () => {
    state.nativeSupervisor = true;
    let calls = 0;
    await expect(admitCurrentDaemonPeer({
      port, homeDir, deadline: 100, now: () => ++calls < 16 ? 0 : 100, _processBirth: () => "birth",
    })).resolves.toBeNull();
    expect(state.nativeRun).not.toHaveBeenCalled();
  });
});
