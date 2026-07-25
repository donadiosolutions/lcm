import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps a fork worker active until the harness terminates its process tree", async () => {
  const pidFile = process.env.LCM_TEST_POSTGRES_FORK_WORKER_PID_FILE;
  expect(pidFile).toBeTruthy();
  process.on("SIGTERM", () => {
    // Exercise the harness's retained process-group SIGKILL escalation.
  });
  writeFileSync(pidFile!, `${process.pid}\n`, { mode: 0o600 });
  await new Promise<void>(() => {
    setInterval(() => undefined, 1_000);
  });
});
