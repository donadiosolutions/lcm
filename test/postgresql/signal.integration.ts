import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  RUN_LABEL,
  createRunNames,
  removeLabeled,
  sanitizeHarnessText,
} from "../../scripts/postgresql-harness.mjs";

const execFileAsync = promisify(execFile);

function killChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

type ProbeMode = "harness" | "consumer" | "fork";

async function launchSignalProbe(mode: ProbeMode = "harness"): Promise<{ child: ChildProcess; runId: string }> {
  const flag = mode === "consumer"
    ? "--consumer-signal-probe"
    : mode === "fork" ? "--fork-consumer-signal-probe" : "--signal-probe";
  const child = spawn(process.execPath, ["scripts/postgresql-harness.mjs", flag], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let readyResolve!: (runId: string) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const timeout = setTimeout(
    () => readyReject(new Error(`signal probe readiness timed out: ${stderr}`)),
    30_000,
  );
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
    const match = stderr.match(
      mode === "consumer"
        ? /PostgreSQL harness consumer probe ready: ([0-9a-f]{32})/u
        : mode === "fork"
          ? /PostgreSQL harness fork consumer probe ready: ([0-9a-f]{32})/u
          : /PostgreSQL harness signal probe ready: ([0-9a-f]{32})/u,
    );
    if (match) readyResolve(match[1]);
  });
  child.once("error", readyReject);
  child.once("exit", (code) => {
    readyReject(new Error(`signal probe exited before readiness (${code}): ${stderr}`));
  });
  try {
    return { child, runId: await ready };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) killChild(child, "SIGKILL");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function runSignalProbe(signal: "SIGHUP" | "SIGINT" | "SIGTERM"): Promise<void> {
  const { child, runId } = await launchSignalProbe();
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
    await expectNoResources(runId);
  } finally {
    if (child.exitCode === null && child.signalCode === null) killChild(child, "SIGKILL");
  }
}

function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function expectNoResources(runId: string): Promise<void> {
  for (const args of [
    ["ps", "--all", "--quiet", "--filter", `label=${RUN_LABEL}=${runId}`],
    ["network", "ls", "--quiet", "--filter", `label=${RUN_LABEL}=${runId}`],
    ["volume", "ls", "--quiet", "--filter", `label=${RUN_LABEL}=${runId}`],
  ]) {
    const { stdout } = await execFileAsync("docker", args);
    expect(stdout.trim()).toBe("");
  }
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

  it("cleans every labeled resource on SIGINT", () => runSignalProbe("SIGINT"), 45_000);
  it("cleans every labeled resource on SIGTERM", () => runSignalProbe("SIGTERM"), 45_000);
  it("cleans every labeled resource on SIGHUP", () => runSignalProbe("SIGHUP"), 45_000);

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
      await expectNoResources(second.runId);
    } finally {
      if (second.child.exitCode === null && second.child.signalCode === null) killChild(second.child, "SIGKILL");
    }
  }, 90_000);

  it("preserves a live parallel run while allocating and cleaning another run", async () => {
    const first = await launchSignalProbe();
    let second: Awaited<ReturnType<typeof launchSignalProbe>> | undefined;
    try {
      second = await launchSignalProbe();
      await expectResources(first.runId);
      const secondCompletion = exited(second.child);
      killChild(second.child, "SIGTERM");
      await expect(secondCompletion).resolves.toEqual({ code: 143, signal: null });
      await expectNoResources(second.runId);
      await expectResources(first.runId);

      const firstCompletion = exited(first.child);
      killChild(first.child, "SIGTERM");
      await expect(firstCompletion).resolves.toEqual({ code: 143, signal: null });
      await expectNoResources(first.runId);
    } finally {
      if (second && second.child.exitCode === null && second.child.signalCode === null) {
        killChild(second.child, "SIGKILL");
      }
      if (first.child.exitCode === null && first.child.signalCode === null) killChild(first.child, "SIGKILL");
    }
  }, 90_000);

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

      third = await launchSignalProbe();
      await expectNoResources(first.runId);
      const thirdCompletion = exited(third.child);
      killChild(third.child, "SIGTERM");
      await expect(thirdCompletion).resolves.toEqual({ code: 143, signal: null });
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
          await cleanupCompletion;
        }
      }
    }
  }, 120_000);

  it("terminates an active local consumer before graceful signal cleanup", async () => {
    const probe = await launchSignalProbe("consumer");
    const pid = await consumerPid(probe.runId);
    try {
      const completion = exited(probe.child);
      killChild(probe.child, "SIGTERM");
      await expect(completion).resolves.toEqual({ code: 143, signal: null });
      await waitForPidExit(pid);
      await expectNoResources(probe.runId);
    } finally {
      if (probe.child.exitCode === null && probe.child.signalCode === null) killChild(probe.child, "SIGKILL");
    }
  }, 45_000);

  it("terminates a persistent Vitest fork worker before cleanup", async () => {
    const probe = await launchSignalProbe("fork");
    const pid = await forkWorkerPid(probe.runId);
    try {
      const completion = exited(probe.child);
      killChild(probe.child, "SIGTERM");
      await expect(completion).resolves.toEqual({ code: 143, signal: null });
      await waitForPidExit(pid);
      await expectNoResources(probe.runId);
    } finally {
      if (probe.child.exitCode === null && probe.child.signalCode === null) killChild(probe.child, "SIGKILL");
    }
  }, 45_000);

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
