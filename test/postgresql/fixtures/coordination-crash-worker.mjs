import process from "node:process";
import {
  PostgreSqlCoordinationRepository,
  PostgreSqlRuntime,
} from "../../../dist/src/storage/postgresql/index.js";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`missing coordination crash fixture value ${name}`);
  return value;
};

const runtime = new PostgreSqlRuntime({
  url: required("LCM_COORDINATION_FIXTURE_URL"),
  caFile: required("LCM_TEST_POSTGRES_CA_FILE"),
  poolMax: 1,
  connectionTimeoutMs: 2_000,
  idleTimeoutMs: 1_000,
  statementTimeoutMs: 5_000,
});
const projectId = required("LCM_COORDINATION_FIXTURE_PROJECT_ID");
const machineId = required("LCM_COORDINATION_FIXTURE_MACHINE_ID");
const resourceKey = required("LCM_COORDINATION_FIXTURE_RESOURCE_KEY");
const repository = new PostgreSqlCoordinationRepository(
  runtime,
  projectId,
  machineId,
);

try {
  const lease = await repository.acquireLease({
    resourceType: "crash-fixture",
    resourceKey,
    processId: "crash-worker",
    operation: "coordinate",
    ttlMs: 1_200,
  });
  if (!lease) throw new Error("coordination crash fixture did not acquire lease");
  await runtime.transaction(async (transaction) => {
    const scoped = new PostgreSqlCoordinationRepository(
      transaction,
      projectId,
      machineId,
    );
    await scoped.acquireTransactionLock({
      resourceType: "crash-fixture",
      resourceKey,
      operation: "coordinate",
      timeoutMs: 1_000,
    });
    process.send?.({
      type: "ready",
      fencingToken: lease.fencingToken.toString(),
    });
    await new Promise(() => undefined);
  }, {
    domain: "coordination",
    operation: "holdCrashFixtureLock",
    projectId,
  });
} catch {
  process.send?.({ type: "error" });
  process.exitCode = 1;
  await runtime.close();
}
