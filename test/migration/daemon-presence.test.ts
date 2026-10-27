import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyMigrationDaemonPresence } from "../../src/migration/daemon-presence.js";
import type { DaemonObservation } from "../../src/daemon/client.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-daemon-presence-"));
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  roots.push(value);
  return value;
}

function realObservation(overrides: Partial<DaemonObservation> = {}): DaemonObservation {
  return {
    status: "ok",
    observation: "identity-only",
    storage: { status: "unverified" },
    version: "1.0.0",
    storageBackend: "sqlite",
    uptime: 100,
    pid: 4242,
    entrypoint: "/opt/lcm/lcm.mjs",
    daemonInstanceId: "generation-1",
    ...overrides,
  };
}

/** A real, definitively dead pid: spawn a trivial child, let it exit, reuse its pid. */
function realDeadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const pid = result.pid;
  if (typeof pid !== "number" || pid <= 0) throw new Error("fixture setup failed to obtain a real exited pid");
  return pid;
}

describe("classifyMigrationDaemonPresence: the present outcome (a genuine, attributable answer)", () => {
  it("classifies present and carries the observed storageBackend even when it disagrees with the live config's backend (the #1384 regression: a live daemon holding a stale startup backend must never read as absent)", async () => {
    const homeDir = home();
    writeFileSync(join(homeDir, ".lcm", "config.json"), '{"storage":{"backend":"sqlite"}}\n', { mode: 0o600 });
    const result = await classifyMigrationDaemonPresence({
      homeDir,
      _operationsForTesting: {
        observe: async () => realObservation({ storageBackend: "postgresql" }),
      },
    });
    expect(result).toEqual({ status: "present", storageBackend: "postgresql", pid: 4242, daemonInstanceId: "generation-1" });
  });

  it("classifies present with an agreeing backend too (the ordinary case)", async () => {
    const homeDir = home();
    const result = await classifyMigrationDaemonPresence({
      homeDir,
      _operationsForTesting: { observe: async () => realObservation({ storageBackend: "sqlite" }) },
    });
    expect(result).toEqual({ status: "present", storageBackend: "sqlite", pid: 4242, daemonInstanceId: "generation-1" });
  });
});

describe("classifyMigrationDaemonPresence: the authoritatively-absent outcome, real filesystem paths, no injection", () => {
  it("classifies authoritatively-absent for real when there is no config, no token, and no pid file at all", async () => {
    const homeDir = home();
    const result = await classifyMigrationDaemonPresence({ homeDir });
    expect(result).toEqual({ status: "authoritatively-absent" });
  });

  it("classifies authoritatively-absent for real when the pid file names a genuinely, verifiably dead process (a real spawned-and-exited child's pid, real process.kill(pid, 0) probe, ESRCH)", async () => {
    const homeDir = home();
    const deadPid = realDeadPid();
    writeFileSync(join(homeDir, ".lcm", "daemon.pid"), `${deadPid}\n`, { mode: 0o600 });
    const result = await classifyMigrationDaemonPresence({ homeDir });
    expect(result).toEqual({ status: "authoritatively-absent" });
  });
});

describe("classifyMigrationDaemonPresence: the unresolvable outcome, never misread as absence", () => {
  it("classifies unresolvable, never absent, when the pid file names a genuinely live process that did not answer (red: this is the exact scenario a two-valued absence check would misclassify)", async () => {
    const homeDir = home();
    // process.pid (this very test process) is guaranteed alive for the
    // duration of this test — a real, not injected, liveness probe.
    writeFileSync(join(homeDir, ".lcm", "daemon.pid"), `${process.pid}\n`, { mode: 0o600 });
    const result = await classifyMigrationDaemonPresence({ homeDir });
    expect(result).toEqual({ status: "unresolvable", evidence: "pidfile-live-no-answer" });
  });

  it("classifies unresolvable for a malformed pid file (real fs read, not injected)", async () => {
    const homeDir = home();
    writeFileSync(join(homeDir, ".lcm", "daemon.pid"), "not-a-pid\n", { mode: 0o600 });
    const result = await classifyMigrationDaemonPresence({ homeDir });
    expect(result).toEqual({ status: "unresolvable", evidence: "pidfile-malformed" });
  });

  it.each([
    ["trailing junk after a dead pid", (deadPid: number) => `${deadPid}junk\n`],
    ["trailing junk after a live pid", () => `${process.pid} extra\n`],
    ["a leading zero", (deadPid: number) => `0${deadPid}\n`],
    ["a signed value", (deadPid: number) => `+${deadPid}\n`],
    ["a hexadecimal prefix", () => "0x10\n"],
    ["a decimal fraction", (deadPid: number) => `${deadPid}.5\n`],
    ["zero", () => "0\n"],
    ["an unsafe integer", () => "9007199254740993\n"],
    ["an empty file", () => ""],
  ])("classifies unresolvable, never probing a pid, for a pid file carrying %s (Codex PR #1653 P2: parseInt accepted a numeric prefix)", async (_name, content) => {
    const homeDir = home();
    writeFileSync(join(homeDir, ".lcm", "daemon.pid"), content(realDeadPid()), { mode: 0o600 });
    const kill = vi.spyOn(process, "kill");
    const result = await classifyMigrationDaemonPresence({ homeDir });
    expect(result).toEqual({ status: "unresolvable", evidence: "pidfile-malformed" });
    expect(kill).not.toHaveBeenCalled();
  });

  it("still accepts a whole-content pid with surrounding whitespace (the format the daemon writes)", async () => {
    const homeDir = home();
    writeFileSync(join(homeDir, ".lcm", "daemon.pid"), `  ${realDeadPid()}\n\n`, { mode: 0o600 });
    expect(await classifyMigrationDaemonPresence({ homeDir })).toEqual({ status: "authoritatively-absent" });
  });

  it("classifies unresolvable for a pid file that cannot be read for a non-ENOENT reason (real EACCES via chmod 0o000, not injected)", async () => {
    const homeDir = home();
    const pidPath = join(homeDir, ".lcm", "daemon.pid");
    writeFileSync(pidPath, "4242\n", { mode: 0o600 });
    chmodSync(pidPath, 0o000);
    try {
      const result = await classifyMigrationDaemonPresence({ homeDir });
      expect(result).toEqual({ status: "unresolvable", evidence: "pidfile-EACCES" });
    } finally {
      chmodSync(pidPath, 0o600);
    }
  });

  it("classifies unresolvable when process.kill itself throws an unexpected errno (real defaultClassifyLiveness code path, process.kill mocked at the OS boundary rather than the whole function replaced)", async () => {
    const homeDir = home();
    writeFileSync(join(homeDir, ".lcm", "daemon.pid"), "4242\n", { mode: 0o600 });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("mock unexpected kill failure") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    });
    try {
      const result = await classifyMigrationDaemonPresence({ homeDir });
      expect(result).toEqual({ status: "unresolvable", evidence: "pidfile-liveness-unresolvable" });
    } finally {
      killSpy.mockRestore();
    }
  });

  it("classifies alive (not dead) for a real defaultClassifyLiveness EPERM (process exists, just not signalable) rather than misreading it as gone", async () => {
    const homeDir = home();
    writeFileSync(join(homeDir, ".lcm", "daemon.pid"), "4242\n", { mode: 0o600 });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("mock EPERM") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });
    try {
      const result = await classifyMigrationDaemonPresence({ homeDir });
      // EPERM means the process exists; the daemon still did not answer,
      // so this must land on unresolvable (a live, unattributable process),
      // not authoritatively-absent -- proving EPERM took the "alive" branch
      // rather than falling through to "dead".
      expect(result).toEqual({ status: "unresolvable", evidence: "pidfile-live-no-answer" });
    } finally {
      killSpy.mockRestore();
    }
  });

  it("propagates a readPidFile unresolvable verdict from the injection seam directly, carrying its evidence", async () => {
    const homeDir = home();
    const result = await classifyMigrationDaemonPresence({
      homeDir,
      _operationsForTesting: { readPidFile: () => ({ status: "unresolvable", evidence: "injected-unresolvable" }) },
    });
    expect(result).toEqual({ status: "unresolvable", evidence: "injected-unresolvable" });
  });

  it("classifies unresolvable when observe() itself throws, rather than falling through to the pid-file side as if it were an ordinary non-answer (a setup failure is not the same fact as no daemon answered)", async () => {
    const homeDir = home();
    const result = await classifyMigrationDaemonPresence({
      homeDir,
      _operationsForTesting: {
        observe: async () => { throw new Error("mock config read failure"); },
      },
    });
    expect(result).toEqual({ status: "unresolvable", evidence: "observe-Error" });
  });

  it("classifies unresolvable when observe() throws a non-Error value", async () => {
    const homeDir = home();
    const result = await classifyMigrationDaemonPresence({
      homeDir,
      _operationsForTesting: {
        observe: async () => { throw "not-an-error-object"; },
      },
    });
    expect(result).toEqual({ status: "unresolvable", evidence: "observe-unknown-error" });
  });

  it("exercises the real network path end to end: a real token file present, a real (refused) HTTP connection attempt, observe() catching the failure and returning null, landing on authoritatively-absent (no live daemon actually listens on this port)", async () => {
    const homeDir = home();
    writeFileSync(join(homeDir, ".lcm", "config.json"), JSON.stringify({ storage: { backend: "sqlite" }, daemon: { port: 3939 } }), { mode: 0o600 });
    writeFileSync(join(homeDir, ".lcm", "daemon.token"), "a-real-token-value\n", { mode: 0o600 });
    const result = await classifyMigrationDaemonPresence({ homeDir });
    expect(result).toEqual({ status: "authoritatively-absent" });
  });

});
