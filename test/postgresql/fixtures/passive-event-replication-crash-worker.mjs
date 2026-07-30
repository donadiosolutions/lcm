import process from "node:process";
import {
  PassiveEventReplicationWorker,
} from "../../../dist/src/daemon/passive-event-replication.js";
import {
  SQLiteLocalHookOutboxFactory,
} from "../../../dist/src/storage/local-hook-outbox.js";
import {
  PostgreSqlPassiveEventRepository,
} from "../../../dist/src/storage/postgresql/passive-event-repository.js";
import {
  PostgreSqlRuntime,
} from "../../../dist/src/storage/postgresql/runtime.js";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`missing passive-event crash fixture value ${name}`);
  return value;
};

const crashPoint = required("LCM_PASSIVE_EVENT_CRASH_POINT");
const allowedCrashPoints = new Set([
  "after-insert",
  "after-apply",
  "after-local-ack",
  "after-remote-prune",
]);
if (!allowedCrashPoints.has(crashPoint)) {
  throw new Error("invalid passive-event crash fixture point");
}

const runtime = new PostgreSqlRuntime({
  url: required("LCM_PASSIVE_EVENT_FIXTURE_URL"),
  caFile: required("LCM_TEST_POSTGRES_CA_FILE"),
  poolMax: 1,
  connectionTimeoutMs: 2_000,
  idleTimeoutMs: 1_000,
  statementTimeoutMs: 5_000,
});
const repository = new PostgreSqlPassiveEventRepository(
  runtime,
  required("LCM_PASSIVE_EVENT_FIXTURE_PROJECT_ID"),
  required("LCM_PASSIVE_EVENT_FIXTURE_MACHINE_ID"),
);
const factory = new SQLiteLocalHookOutboxFactory();
const local = await factory.open(
  required("LCM_PASSIVE_EVENT_FIXTURE_OUTBOX_PATH"),
);
let crashed = false;

const crash = async () => new Promise(() => {
  crashed = true;
  const terminate = () => process.kill(process.pid, "SIGKILL");
  if (process.send) {
    process.send({ type: "crashing", crashPoint }, terminate);
  } else {
    terminate();
  }
});

const remote = new Proxy(repository, {
  get(target, property, receiver) {
    if (property === "insertEvents" && crashPoint === "after-insert") {
      return async (...args) => {
        const value = await target.insertEvents(...args);
        await crash();
        return value;
      };
    }
    if (property === "completeApplied" && crashPoint === "after-apply") {
      return async (...args) => {
        const value = await target.completeApplied(...args);
        await crash();
        return value;
      };
    }
    if (property === "pruneApplied" && crashPoint === "after-remote-prune") {
      return async (...args) => {
        const value = await target.pruneApplied(...args);
        await crash();
        return value;
      };
    }
    const value = Reflect.get(target, property, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

const localOutbox = new Proxy(local, {
  get(target, property, receiver) {
    if (property === "markAcknowledged" && crashPoint === "after-local-ack") {
      return async (...args) => {
        const value = await target.markAcknowledged(...args);
        await crash();
        return value;
      };
    }
    const value = Reflect.get(target, property, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

try {
  const worker = new PassiveEventReplicationWorker({
    local: localOutbox,
    remote,
    applyEvent: async (executor, event) => {
      await executor.query({
        text: `INSERT INTO public.passive_event_effects(event_id, machine_id)
               VALUES($1, $2)
               ON CONFLICT(event_id) DO NOTHING`,
        values: [event.eventId, event.machineId],
      }, {
        domain: "passive-events",
        operation: "applyCrashFixtureEffect",
        projectId: repository.projectId,
        machineId: event.machineId,
      });
    },
  }, {
    processId: required("LCM_PASSIVE_EVENT_FIXTURE_PROCESS_ID"),
    batchSize: 10,
    staleClaimMs: 50,
    leaseTtlMs: 250,
    retryBaseMs: 1,
    retryMaxMs: 10,
    retryJitterRatio: 0,
    quarantineAfterAttempts: 3,
  });
  await worker.runOnce();
  if (!crashed) throw new Error("passive-event crash point was not reached");
} catch {
  process.send?.({ type: "error" });
  process.exitCode = 1;
} finally {
  if (!crashed) {
    await Promise.allSettled([factory.close(), runtime.close()]);
  }
}
