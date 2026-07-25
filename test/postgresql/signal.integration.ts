import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  RUN_LABEL,
  auditHarnessRunResources,
  createHarnessAllocationMarkerParser,
  createSignalCleanupDiagnosticParser,
  createRunNames,
  removeLabeled,
  resolveSignalProbeReadinessTimeout,
  sanitizeHarnessText,
} from "../../scripts/postgresql-harness.mjs";

const execFileAsync = promisify(execFile);
const SIGNAL_PROBE_READINESS_TIMEOUT_MS = resolveSignalProbeReadinessTimeout(process.env);
const SIGNAL_CASE_CLEANUP_MARGIN_MS = 30_000;
// The surviving-consumer case can launch first, second, third, and fallback cleanup probes.
const MAX_SIGNAL_PROBE_FAN_OUT = 4;
const launchedRunIds = new Set<string>();

function signalCaseTimeout(probeCount: number): number {
  return SIGNAL_PROBE_READINESS_TIMEOUT_MS * probeCount + SIGNAL_CASE_CLEANUP_MARGIN_MS;
}

function killChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

type ProbeMode = "harness" | "consumer" | "fork" | "allocation-failure";

interface SignalProbe {
  readonly child: ChildProcess;
  readonly runId: string;
  cleanupFailure(): string | undefined;
}

function expectSignalCleanupSucceeded(probe: SignalProbe): void {
  const failure = probe.cleanupFailure();
  expect(failure, failure ?? "PostgreSQL signal cleanup succeeded").toBeUndefined();
}

async function launchSignalProbe(mode: ProbeMode = "harness"): Promise<SignalProbe> {
  const flag = mode === "consumer"
    ? "--consumer-signal-probe"
    : mode === "fork"
      ? "--fork-consumer-signal-probe"
      : mode === "allocation-failure" ? "--allocation-failure-probe" : "--signal-probe";
  const child = spawn(process.execPath, ["scripts/postgresql-harness.mjs", flag], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let readyMarkerTail = "";
  const allocationParser = createHarnessAllocationMarkerParser(launchedRunIds);
  const cleanupDiagnosticParser = createSignalCleanupDiagnosticParser();
  let readyResolve!: (runId: string) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const timeout = setTimeout(
    () => readyReject(new Error("signal probe readiness timed out")),
    SIGNAL_PROBE_READINESS_TIMEOUT_MS,
  );
  child.stderr?.on("data", (chunk) => {
    const output = String(chunk);
    allocationParser.write(output);
    cleanupDiagnosticParser.write(chunk);
    const readyCandidate = `${readyMarkerTail}${output}`;
    readyMarkerTail = readyCandidate.slice(-128);
    const match = readyCandidate.match(
      mode === "consumer"
        ? /PostgreSQL harness consumer probe ready: ([0-9a-f]{32})/u
        : mode === "fork"
          ? /PostgreSQL harness fork consumer probe ready: ([0-9a-f]{32})/u
          : /PostgreSQL harness signal probe ready: ([0-9a-f]{32})/u,
    );
    if (match) readyResolve(match[1]);
  });
  child.once("error", () => readyReject(new Error("signal probe could not start")));
  child.once("close", (code) => {
    allocationParser.end();
    readyReject(new Error(`signal probe exited before readiness (${code})`));
  });
  try {
    const runId = await ready;
    return {
      child,
      runId,
      cleanupFailure: () => cleanupDiagnosticParser.diagnostic(),
    };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) killChild(child, "SIGKILL");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function runSignalProbe(signal: "SIGHUP" | "SIGINT" | "SIGTERM"): Promise<void> {
  const probe = await launchSignalProbe();
  const { child, runId } = probe;
  try {
    const completion = exited(child);
    killChild(child, signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (child.exitCode === null && child.signalCode === null) killChild(child, signal);
    const exit = await completion;
    expect(exit).toEqual({
      code: signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143,
      signal: null,
    });
    expectSignalCleanupSucceeded(probe);
    await expectNoResources(runId);
  } finally {
    if (child.exitCode === null && child.signalCode === null) killChild(child, "SIGKILL");
  }
}

function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function expectNoResources(runId: string): Promise<void> {
  await auditHarnessRunResources([runId], (args) => execFileAsync("docker", args));
}

async function expectResources(runId: string): Promise<void> {
  for (const args of [
    ["ps", "--all", "--quiet", "--filter", `label=${RUN_LABEL}=${runId}`],
    ["network", "ls", "--quiet", "--filter", `label=${RUN_LABEL}=${runId}`],
    ["volume", "ls", "--quiet", "--filter", `label=${RUN_LABEL}=${runId}`],
  ]) {
    const { stdout } = await execFileAsync("docker", args);
    expect(stdout.trim()).not.toBe("");
  }
}

afterAll(async () => {
  await auditHarnessRunResources(launchedRunIds, (args) => execFileAsync("docker", args));
}, signalCaseTimeout(MAX_SIGNAL_PROBE_FAN_OUT));

async function harnessDirectory(runId: string): Promise<string> {
  const { stdout } = await execFileAsync("docker", ["container", "inspect", createRunNames(runId).container]);
  const record = JSON.parse(stdout)[0] as { Mounts: Array<{ Destination: string; Source: string }> };
  return record.Mounts.find((mount) => mount.Destination === "/run/lcm-harness")!.Source;
}

async function consumerPid(runId: string): Promise<number> {
  const directory = await harnessDirectory(runId);
  return (JSON.parse(readFileSync(`${directory}/consumer-owner.json`, "utf8")) as { pid: number }).pid;
}

async function forkWorkerPid(runId: string): Promise<number> {
  const directory = await harnessDirectory(runId);
  return Number(readFileSync(`${directory}/fork-worker.pid`, "utf8").trim());
}

async function waitForPidExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("consumer process did not exit");
}

async function terminatePid(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  await waitForPidExit(pid);
}

describe("PostgreSQL harness signal teardown", () => {
  it("registers an allocated run before a deterministic pre-readiness failure", async () => {
    const before = new Set(launchedRunIds);

    await expect(launchSignalProbe("allocation-failure")).rejects.toThrow(
      "signal probe exited before readiness (1)",
    );

    const allocated = [...launchedRunIds].filter((runId) => !before.has(runId));
    expect(allocated).toHaveLength(1);
    await expectNoResources(allocated[0]);
  }, signalCaseTimeout(1));

  it("ignores only an ESRCH race while signaling a child", () => {
    const exitedChild = {
      kill: () => { throw Object.assign(new Error("already exited"), { code: "ESRCH" }); },
    } as unknown as ChildProcess;
    const deniedChild = {
      kill: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
    } as unknown as ChildProcess;

    expect(() => killChild(exitedChild, "SIGTERM")).not.toThrow();
    expect(() => killChild(deniedChild, "SIGTERM")).toThrow("denied");
  });

  it("cleans every labeled resource on SIGINT", () => runSignalProbe("SIGINT"), signalCaseTimeout(1));
  it("cleans every labeled resource on SIGTERM", () => runSignalProbe("SIGTERM"), signalCaseTimeout(1));
  it("cleans every labeled resource on SIGHUP", () => runSignalProbe("SIGHUP"), signalCaseTimeout(1));

  it("reclaims a SIGKILL orphan before the next run allocates resources", async () => {
    const first = await launchSignalProbe();
    const firstCompletion = exited(first.child);
    killChild(first.child, "SIGKILL");
    await expect(firstCompletion).resolves.toEqual({ code: null, signal: "SIGKILL" });

    const second = await launchSignalProbe();
    try {
      await expectNoResources(first.runId);
      const secondCompletion = exited(second.child);
      killChild(second.child, "SIGTERM");
      await expect(secondCompletion).resolves.toEqual({ code: 143, signal: null });
      expectSignalCleanupSucceeded(second);
      await expectNoResources(second.runId);
    } finally {
      if (second.child.exitCode === null && second.child.signalCode === null) killChild(second.child, "SIGKILL");
    }
  }, signalCaseTimeout(2));

  it("preserves a live parallel run while allocating and cleaning another run", async () => {
    const first = await launchSignalProbe();
    let second: Awaited<ReturnType<typeof launchSignalProbe>> | undefined;
    try {
      second = await launchSignalProbe();
      await expectResources(first.runId);
      const secondCompletion = exited(second.child);
      killChild(second.child, "SIGTERM");
      await expect(secondCompletion).resolves.toEqual({ code: 143, signal: null });
      expectSignalCleanupSucceeded(second);
      await expectNoResources(second.runId);
      await expectResources(first.runId);

      const firstCompletion = exited(first.child);
      killChild(first.child, "SIGTERM");
      await expect(firstCompletion).resolves.toEqual({ code: 143, signal: null });
      expectSignalCleanupSucceeded(first);
      await expectNoResources(first.runId);
    } finally {
      if (second && second.child.exitCode === null && second.child.signalCode === null) {
        killChild(second.child, "SIGKILL");
      }
      if (first.child.exitCode === null && first.child.signalCode === null) killChild(first.child, "SIGKILL");
    }
  }, signalCaseTimeout(2));

  it("preserves a surviving local test consumer until that exact process exits", async () => {
    const first = await launchSignalProbe("consumer");
    const firstCompletion = exited(first.child);
    killChild(first.child, "SIGKILL");
    await expect(firstCompletion).resolves.toEqual({ code: null, signal: "SIGKILL" });

    const pid = await consumerPid(first.runId);
    let second: Awaited<ReturnType<typeof launchSignalProbe>> | undefined;
    let third: Awaited<ReturnType<typeof launchSignalProbe>> | undefined;
    let recovered = false;
    try {
      second = await launchSignalProbe();
      await expectResources(first.runId);
      await terminatePid(pid);

      const secondCompletion = exited(second.child);
      killChild(second.child, "SIGTERM");
      await expect(secondCompletion).resolves.toEqual({ code: 143, signal: null });
      expectSignalCleanupSucceeded(second);
      await expectNoResources(second.runId);

      third = await launchSignalProbe();
      await expectNoResources(first.runId);
      const thirdCompletion = exited(third.child);
      killChild(third.child, "SIGTERM");
      await expect(thirdCompletion).resolves.toEqual({ code: 143, signal: null });
      expectSignalCleanupSucceeded(third);
      await expectNoResources(third.runId);
      recovered = true;
    } finally {
      await terminatePid(pid);
      if (third && third.child.exitCode === null && third.child.signalCode === null) killChild(third.child, "SIGKILL");
      if (second && second.child.exitCode === null && second.child.signalCode === null) killChild(second.child, "SIGKILL");
      if (!recovered) {
        const cleanup = await launchSignalProbe();
        try {
          await expectNoResources(first.runId);
        } finally {
          const cleanupCompletion = exited(cleanup.child);
          killChild(cleanup.child, "SIGTERM");
          await expect(cleanupCompletion).resolves.toEqual({ code: 143, signal: null });
          expectSignalCleanupSucceeded(cleanup);
          await expectNoResources(cleanup.runId);
        }
      }
    }
  }, signalCaseTimeout(MAX_SIGNAL_PROBE_FAN_OUT));

  it("terminates an active local consumer before graceful signal cleanup", async () => {
    const probe = await launchSignalProbe("consumer");
    const pid = await consumerPid(probe.runId);
    try {
      const completion = exited(probe.child);
      killChild(probe.child, "SIGTERM");
      await expect(completion).resolves.toEqual({ code: 143, signal: null });
      expectSignalCleanupSucceeded(probe);
      await waitForPidExit(pid);
      await expectNoResources(probe.runId);
    } finally {
      if (probe.child.exitCode === null && probe.child.signalCode === null) killChild(probe.child, "SIGKILL");
    }
  }, signalCaseTimeout(1));

  it("terminates a persistent Vitest fork worker before cleanup", async () => {
    const probe = await launchSignalProbe("fork");
    const pid = await forkWorkerPid(probe.runId);
    try {
      const completion = exited(probe.child);
      killChild(probe.child, "SIGTERM");
      await expect(completion).resolves.toEqual({ code: 143, signal: null });
      expectSignalCleanupSucceeded(probe);
      await waitForPidExit(pid);
      await expectNoResources(probe.runId);
    } finally {
      if (probe.child.exitCode === null && probe.child.signalCode === null) killChild(probe.child, "SIGKILL");
    }
  }, signalCaseTimeout(1));

  it("propagates and sanitizes a real Docker inspection failure", async () => {
    const unavailableSocket = "/tmp/lcm-postgresql-harness-unavailable-cleanup.sock";
    const dockerRunner = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
      const { stdout, stderr } = await execFileAsync("docker", ["--host", `unix://${unavailableSocket}`, ...args]);
      return { stdout, stderr };
    };
    const failure = await removeLabeled(
      "container",
      "lcm-pg-unreachable-daemon",
      "a".repeat(32),
      dockerRunner,
    ).catch((error: unknown) => error) as { code: number; stderr: string };

    expect(failure.code).not.toBe(0);
    expect(failure.stderr).toContain(unavailableSocket);
    expect(sanitizeHarnessText(failure.stderr, [unavailableSocket])).not.toContain(unavailableSocket);
  });
});
