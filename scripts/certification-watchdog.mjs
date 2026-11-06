#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { certificationDeadlineSeconds, loadCertificationContract } from "../test/certification/contract.mjs";
import { parseCertificationArguments } from "./certification-harness.mjs";

const KILL_GRACE_SECONDS = 60;

export function parseWatchdogArguments(argv) {
  return parseCertificationArguments(argv);
}

export function certificationWatchdogDeadline(contract, options) {
  const terminateSeconds = certificationDeadlineSeconds(contract, options);
  return { terminateSeconds, killSeconds: terminateSeconds + KILL_GRACE_SECONDS };
}

function signalOwnedGroup(child, signal) {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch {} }
}

function ownedGroupAlive(child) {
  if (child.pid === undefined || process.platform === "win32") return false;
  try { process.kill(-child.pid, 0); return true; }
  catch { return false; }
}

export async function runCertificationWatchdog(argv, dependencies = {}) {
  const options = parseWatchdogArguments(argv);
  const loaded = loadCertificationContract(options.contractPath, { requireApproved: false });
  const deadlines = certificationWatchdogDeadline(loaded.contract, options);
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const signalGroup = dependencies.signalGroup ?? signalOwnedGroup;
  const groupAlive = dependencies.groupAlive ?? ownedGroupAlive;
  const harness = fileURLToPath(new URL("./certification-harness.mjs", import.meta.url));
  const child = spawnProcess(process.execPath, [harness, ...argv], {
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  return await new Promise((resolve, reject) => {
    let killTimer;
    let terminateTimer;
    let terminating = false;
    let leaderOutcome;
    let groupCleared = false;
    let settled = false;
    const finish = () => {
      if (settled || leaderOutcome === undefined || !groupCleared) return;
      settled = true;
      cleanup();
      const { code, signal } = leaderOutcome;
      if (code === 0) resolve({ code, signal, deadlines });
      else reject(Object.assign(new Error(`certification harness exited with ${code ?? signal}`), { code, signal }));
    };
    const verifyGroupGone = (attempt = 0) => {
      if (!groupAlive(child)) { groupCleared = true; finish(); return; }
      if (attempt >= 50) { cleanup(); reject(new Error("certification process group remained after SIGKILL")); return; }
      setTimeout(() => verifyGroupGone(attempt + 1), 100);
    };
    const terminate = (signal = "SIGTERM") => {
      if (!terminating) {
        terminating = true;
        signalGroup(child, signal);
        killTimer = setTimeout(() => { signalGroup(child, "SIGKILL"); verifyGroupGone(); }, KILL_GRACE_SECONDS * 1000);
      }
    };
    const handlers = { SIGINT: () => terminate("SIGINT"), SIGTERM: () => terminate("SIGTERM"), SIGHUP: () => terminate("SIGHUP") };
    for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
    const cleanup = () => {
      clearTimeout(terminateTimer); clearTimeout(killTimer);
      for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
    };
    terminateTimer = setTimeout(() => {
      terminate("SIGTERM");
    }, deadlines.terminateSeconds * 1000);
    child.once("error", (error) => {
      cleanup(); reject(error);
    });
    child.once("exit", (code, signal) => {
      leaderOutcome = { code, signal };
      if (!groupAlive(child)) { groupCleared = true; finish(); }
      else terminate("SIGTERM");
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCertificationWatchdog(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Certification watchdog failed: ${error.message}\n`);
    process.exitCode = typeof error.code === "number" ? error.code : 1;
  });
}
