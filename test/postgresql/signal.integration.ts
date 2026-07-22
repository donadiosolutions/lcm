import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { RUN_LABEL } from "../../scripts/postgresql-harness.mjs";

const execFileAsync = promisify(execFile);

async function runSignalProbe(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  const child = spawn(process.execPath, ["scripts/postgresql-harness.mjs", "--signal-probe"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let runId: string | undefined;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const timeout = setTimeout(() => readyReject(new Error("signal probe readiness timed out")), 30_000);
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
    const match = stderr.match(/PostgreSQL harness signal probe ready: ([0-9a-f]{32})/u);
    if (match) {
      runId = match[1];
      readyResolve();
    }
  });
  child.once("error", readyReject);
  child.once("exit", (code) => {
    if (!runId) readyReject(new Error(`signal probe exited before readiness (${code}): ${stderr}`));
  });
  try {
    await ready;
    const completion = exited(child);
    child.kill(signal);
    const exit = await completion;
    expect(exit).toEqual({ code: signal === "SIGINT" ? 130 : 143, signal: null });
    await expectNoResources(runId!);
  } finally {
    clearTimeout(timeout);
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

describe("PostgreSQL harness signal teardown", () => {
  it("cleans every labeled resource on SIGINT", () => runSignalProbe("SIGINT"), 45_000);
  it("cleans every labeled resource on SIGTERM", () => runSignalProbe("SIGTERM"), 45_000);
});
