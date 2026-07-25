import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateKey = Symbol.for("lcm.vitest.runtimeHome");

type RuntimeHomeState = {
  realHome: string | undefined;
  realUserProfile: string | undefined;
  testHome: string;
  cleanupRegistered: boolean;
};

const globals = globalThis as typeof globalThis & {
  [stateKey]?: RuntimeHomeState;
};

if (!globals[stateKey]) {
  const realHome = process.env.LCM_TEST_REAL_HOME ?? process.env.HOME;
  const realUserProfile = process.env.LCM_TEST_REAL_USERPROFILE ?? process.env.USERPROFILE;
  const workerId = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? "main";
  const testHome = join(tmpdir(), `lcm-vitest-home-${process.pid}-${workerId}`);

  globals[stateKey] = {
    realHome,
    realUserProfile,
    testHome,
    cleanupRegistered: false,
  };
}

const state = globals[stateKey];
process.env.LCM_TEST_REAL_HOME = state.realHome ?? "";
process.env.LCM_TEST_REAL_USERPROFILE = state.realUserProfile ?? "";
process.env.LCM_TEST_HOME = state.testHome;
process.env.HOME = state.testHome;
process.env.USERPROFILE = state.testHome;

mkdirSync(join(state.testHome, ".lcm"), { recursive: true });
mkdirSync(join(state.testHome, ".claude"), { recursive: true });
mkdirSync(join(state.testHome, ".codex"), { recursive: true });

if (!state.cleanupRegistered) {
  state.cleanupRegistered = true;
  process.once("exit", () => {
    rmSync(state.testHome, { recursive: true, force: true });
  });
}
