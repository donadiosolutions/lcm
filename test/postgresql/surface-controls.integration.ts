import { registerControlContract } from "../surface-parity/control-contract.js";
import { createCertificate, loadMatrix, sourceDigest } from "../../scripts/surface-parity-artifact.mjs";
import { beforeAll } from "vitest";
import { assertHarnessReady } from "./harness.js";

beforeAll(assertHarnessReady, 120_000);

registerControlContract({
  emit(backend, rows, cleanup) {
    console.log(createCertificate(loadMatrix(), {
      producer: "controls", backend, rows, cleanup,
      runId: process.env.LCM_TEST_POSTGRES_RUN_ID, sourceDigest: sourceDigest(),
    }));
  },
});
