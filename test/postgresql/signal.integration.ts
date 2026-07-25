import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  RUN_LABEL,
  removeLabeled,
  sanitizeHarnessText,
} from "../../scripts/postgresql-harness.mjs";

const execFileAsync = promisify(execFile);

async function launchSignalProbe(): Promise<{ child: ChildProcess; runId: string }> {
  const child = spawn(process.execPath, ["scripts/postgresql-harness.mjs", "--signal-probe"], {
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
  const timeout = setTimeout(() => readyReject(new Error("signal probe readiness timed out")), 30_000);
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
    const match = stderr.match(/PostgreSQL harness signal probe ready: ([0-9a-f]{32})/u);
    if (match) readyResolve(match[1]);
  });
  child.once("error", readyReject);
  child.once("exit", (code) => {
    readyReject(new Error(`signal probe exited before readiness (${code}): ${stderr}`));
  });
  try {
    return { child, runId: await ready };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function runSignalProbe(signal: "SIGHUP" | "SIGINT" | "SIGTERM"): Promise<void> {
  const { child, runId } = await launchSignalProbe();
  try {
    const completion = exited(child);
    child.kill(signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    const exit = await completion;
    expect(exit).toEqual({
      code: signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143,
      signal: null,
    });
    await expectNoResources(runId);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
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

describe("PostgreSQL harness signal teardown", () => {
  it("cleans every labeled resource on SIGINT", () => runSignalProbe("SIGINT"), 45_000);
  it("cleans every labeled resource on SIGTERM", () => runSignalProbe("SIGTERM"), 45_000);
  it("cleans every labeled resource on SIGHUP", () => runSignalProbe("SIGHUP"), 45_000);

  it("reclaims a SIGKILL orphan before the next run allocates resources", async () => {
    const first = await launchSignalProbe();
    const firstCompletion = exited(first.child);
    first.child.kill("SIGKILL");
    await expect(firstCompletion).resolves.toEqual({ code: null, signal: "SIGKILL" });

    const second = await launchSignalProbe();
    try {
      await expectNoResources(first.runId);
      const secondCompletion = exited(second.child);
      second.child.kill("SIGTERM");
      await expect(secondCompletion).resolves.toEqual({ code: 143, signal: null });
      await expectNoResources(second.runId);
    } finally {
      if (second.child.exitCode === null && second.child.signalCode === null) second.child.kill("SIGKILL");
    }
  }, 90_000);

  it("preserves a live parallel run while allocating and cleaning another run", async () => {
    const first = await launchSignalProbe();
    let second: Awaited<ReturnType<typeof launchSignalProbe>> | undefined;
    try {
      second = await launchSignalProbe();
      await expectResources(first.runId);
      const secondCompletion = exited(second.child);
      second.child.kill("SIGTERM");
      await expect(secondCompletion).resolves.toEqual({ code: 143, signal: null });
      await expectNoResources(second.runId);
      await expectResources(first.runId);

      const firstCompletion = exited(first.child);
      first.child.kill("SIGTERM");
      await expect(firstCompletion).resolves.toEqual({ code: 143, signal: null });
      await expectNoResources(first.runId);
    } finally {
      if (second && second.child.exitCode === null && second.child.signalCode === null) {
        second.child.kill("SIGKILL");
      }
      if (first.child.exitCode === null && first.child.signalCode === null) first.child.kill("SIGKILL");
    }
  }, 90_000);

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
