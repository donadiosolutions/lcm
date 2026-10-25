// Test-only worker for the cutover rehearsal. It drives the real apply sequence through the existing named copy seam
// and holds at that seam so the parent can kill this exact process; it is not an operator interface.
import process from "node:process";
import { resolveMigrationExpectedIdentity, resolveMigrationPreflight } from "../../../dist/src/migration/cli-preflight.js";
import { performMigrationApplyThroughCapture } from "../../../dist/src/migration/apply.js";
import { performMigrationApplyGenesisAndCopy } from "../../../dist/src/migration/apply-genesis-copy.js";

const homeDir = process.env.HOME;
const cwd = process.cwd();
const boundary = process.env.LCM_REHEARSAL_WORKER_BOUNDARY ?? "after-batch-readback";
const fail = (reason) => {
  process.send?.({ type: "failed", reason });
  process.exit(3);
};

const preflight = await resolveMigrationPreflight({ cwd, homeDir });
if (preflight.status !== "ready") fail("preflight-" + preflight.status);
const identity = await resolveMigrationExpectedIdentity({ preflight, cwd, homeDir });
if (identity.status !== "resolved") fail("identity-" + identity.status);
const generationId = preflight.candidate.generationId;
const captured = await performMigrationApplyThroughCapture({ cwd, homeDir, base: preflight.base, confirmGenerationId: generationId });
if (captured.status !== "captured") fail("capture-" + captured.status);

let held = false;
const outcome = await performMigrationApplyGenesisAndCopy({
  homeDir,
  generationId: captured.generationId,
  maintenanceChecksumSha256: captured.maintenanceChecksumSha256,
  settings: preflight.targetConfig.postgresql,
  expectedOwner: preflight.targetConfig.postgresql.migrationRole,
  expectedIdentity: identity.expectedIdentity,
  ownerProcessId: "cutover-rehearsal-kill-worker",
  maxRecords: 1,
  maxBytes: 150994944,
  leaseTtlMs: 1000,
  testing: {
    observe: async (name) => {
      if (name !== boundary || held) return;
      held = true;
      // The durable write for this boundary has completed; announce it and wait to be killed.
      process.send?.({ type: "ready", boundary: name, generationId });
      await new Promise(() => undefined);
    },
  },
});
fail("copy-completed-without-reaching-" + boundary + "-" + String(outcome.status));
