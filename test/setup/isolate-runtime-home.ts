import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { inject } from "vitest";
import { RUNTIME_HOME_ROOT_CONTEXT } from "./runtime-home-global.js";

const stateKey = Symbol.for("lcm.vitest.runtimeHome");

type RuntimeHomeState = {
  realHome: string | undefined;
  realUserProfile: string | undefined;
  runtimeHomeRoot: string;
  testHome: string;
  workerTemp: string;
};

const globals = globalThis as typeof globalThis & {
  [stateKey]?: RuntimeHomeState;
};

const runtimeHomeRoot = inject(RUNTIME_HOME_ROOT_CONTEXT);
if (!globals[stateKey] || globals[stateKey].runtimeHomeRoot !== runtimeHomeRoot) {
  const realHome = process.env.LCM_TEST_REAL_HOME ?? process.env.HOME;
  const realUserProfile = process.env.LCM_TEST_REAL_USERPROFILE ?? process.env.USERPROFILE;
  const workerId = (process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? "main")
    .replace(/[^A-Za-z0-9_-]/gu, "_");
  const testHome = join(runtimeHomeRoot, `worker-${process.pid}-${workerId}`);
  const workerTemp = join(runtimeHomeRoot, `worker-tmp-${process.pid}-${workerId}`);

  globals[stateKey] = {
    realHome,
    realUserProfile,
    runtimeHomeRoot,
    testHome,
    workerTemp,
  };
}

const state = globals[stateKey];
process.env.LCM_TEST_REAL_HOME = state.realHome ?? "";
process.env.LCM_TEST_REAL_USERPROFILE = state.realUserProfile ?? "";
process.env.LCM_TEST_HOME = state.testHome;
process.env.HOME = state.testHome;
process.env.USERPROFILE = state.testHome;
process.env.LCM_TEST_HARNESS_TMPDIR ??= dirname(state.runtimeHomeRoot);
process.env.TMPDIR = state.workerTemp;
process.env.TMP = state.workerTemp;
process.env.TEMP = state.workerTemp;

mkdirSync(join(state.testHome, ".lcm"), { recursive: true });
mkdirSync(join(state.testHome, ".claude"), { recursive: true });
mkdirSync(join(state.testHome, ".codex"), { recursive: true });
mkdirSync(state.workerTemp, { recursive: true, mode: 0o700 });
chmodSync(state.workerTemp, 0o700);
