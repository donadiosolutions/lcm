import { lstatSync } from "node:fs";
import {
  createSupervisor,
  createSupervisorSpec,
  managedLaunchEnvironmentDigest,
} from "../../src/daemon/supervisor.js";

const stateRoot = process.env.LCM_UMASK_STATE_ROOT;
const rawMask = process.env.LCM_UMASK_MASK;
if (stateRoot === undefined || rawMask === undefined) throw new Error("missing child fixture inputs");
const mask = Number.parseInt(rawMask, 8);
if (!Number.isSafeInteger(mask) || mask < 0 || mask > 0o777) throw new Error("invalid child mask");
process.umask(mask);

const environment = { HOME: "/home/test", PATH: "/usr/bin" };
const spec = createSupervisorSpec({
  kind: "systemd-user",
  stateRoot,
  port: 3737,
  nonce: `umask-${rawMask}`,
  executable: "/usr/bin/node",
  args: ["/opt/lcm/dist/lcm.mjs", "daemon", "run-managed"],
  launchEnvironment: environment,
});
const managerOutput = [
  "LoadState=loaded",
  "ActiveState=active",
  "SubState=running",
  "MainPID=4321",
  `Environment=LCM_SUPERVISOR_MARKER=${spec.marker} LCM_SUPERVISOR_SCOPE=${spec.scopeDigest} LCM_SUPERVISOR_STATE_ROOT=${spec.stateRoot} LCM_SUPERVISOR_PORT=${spec.port} LCM_SUPERVISOR_NONCE=${spec.nonce} LCM_SUPERVISOR_EXECUTABLE=${spec.executable} LCM_SUPERVISOR_ARGS=${JSON.stringify(spec.args)} LCM_SUPERVISOR_CWD= LCM_SUPERVISOR_ENV_DIGEST=${managedLaunchEnvironmentDigest(spec, "systemd-user", process.getuid?.() ?? -1, environment)}`,
].join("\n");
let showCalls = 0;
const calls: string[] = [];
const supervisor = createSupervisor("systemd-user", {
  platform: "linux",
  uid: process.getuid?.() ?? -1,
  environment,
  run: async (command) => {
    calls.push(command);
    if (command === "systemd-run") return { code: 0, stdout: "started" };
    showCalls += 1;
    return showCalls === 1
      ? { code: 1, stderr: "Unit is not-found" }
      : { code: 0, stdout: managerOutput };
  },
});

let outcome: "success" | "failure" = "success";
let message = "";
try {
  await supervisor.start(spec);
} catch (error) {
  outcome = "failure";
  message = error instanceof Error ? error.message : String(error);
}
const mode = (() => {
  try {
    return (lstatSync(`${stateRoot}/daemon-tmp`, { bigint: true }).mode & 0o7777n).toString(8);
  } catch {
    return null;
  }
})();
process.stdout.write(JSON.stringify({ calls, message, mode, outcome }));
