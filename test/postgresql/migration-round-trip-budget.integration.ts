import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { closeLcmConnection } from "../../src/db/connection.js";
import { performMigrationActivateCommand } from "../../src/migration/cli-activate.js";
import { performMigrationApply } from "../../src/migration/cli-apply.js";
import { performMigrationPlan } from "../../src/migration/cli-plan.js";
import { resolveMigrationPreflight } from "../../src/migration/cli-preflight.js";
import { performMigrationVerifyCommand } from "../../src/migration/cli-verify.js";
import { prepareSqliteMigrationEnrollment } from "../../src/migration/maintenance.js";
import { resolveProjectIdentity } from "../../src/project-map.js";
import { configPath } from "../../src/runtime-paths.js";
import type { PostgreSqlConnectionSettings } from "../../src/storage/postgresql/contracts.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import { DEFAULT_SNAPSHOT_IDLE_TIMEOUT_MS } from "../../src/storage/postgresql/snapshot-session.js";
import { assertHarnessReady, withPostgreSqlTestDatabase } from "./harness.js";
import {
  DAEMON_PORT,
  dropActivationRole,
  grantRuntimeActivationRole,
  provisionActivationRole,
} from "./migration-activation-fixture.js";
import {
  postgreSqlUrlTarget,
  startRoundTripRelay,
  viaRoundTripRelay,
  type RoundTripRelay,
} from "./round-trip-relay.js";

beforeAll(assertHarnessReady);

/**
 * Exchange budget of the public migration steps (#1869). A counting relay
 * sits between plan, apply, verify and activate and the harness database,
 * and each step must stay within the request/response exchanges and SQL
 * dispatches it needed when its budget was recorded. Nothing is timed. The
 * idle-validation SELECT 1 a connection gets after a second of wall-clock
 * idleness is counted apart and excluded. The only slack is connection
 * setup: the recorded connection count times one connection's setup turns,
 * and one dispatch per recorded connection.
 */

const EXPECTED_OWNER = "lcm_test_migrator";
/** The fixed pool bound and the shipped idle timeout, so no step loses a pooled connection mid-step. */
const POOL_MAX = 4;
const IDLE_TIMEOUT_MS = 30_000;

const STEPS = ["plan", "apply", "verify", "activate"] as const;
type Step = (typeof STEPS)[number];

interface StepCounts {
  /** Relay turns: request/response exchanges, connection setup and teardown included. */
  readonly turns: number;
  readonly connections: number;
  /** SQL messages the process sent, idle-validation probes excluded. */
  readonly dispatches: number;
  readonly idleProbes: number;
}

/**
 * This fixture's counts after #1869 slice 1. On origin/main 7790f1f3 the
 * same steps needed plan 34 turns and 22 dispatches, apply 2821 and 2773,
 * verify 496 and 472, and activate 413 and 383, over the same connections.
 */
const MEASURED: Readonly<Record<Step, Readonly<{ turns: number; dispatches: number; connections: number }>>> = {
  plan: { turns: 34, dispatches: 22, connections: 2 },
  apply: { turns: 2565, dispatches: 2517, connections: 8 },
  verify: { turns: 319, dispatches: 295, connections: 4 },
  activate: { turns: 274, dispatches: 244, connections: 5 },
};

function isIdleValidationProbe(config: unknown): boolean {
  return typeof config === "object" && config !== null
    && (config as { text?: unknown }).text === "SELECT 1" && "query_timeout" in config;
}

/** Counts every query any pg client in this process sends. */
function countDispatches() {
  let dispatches = 0;
  let idleProbes = 0;
  const original = Client.prototype.query;
  const spy = vi.spyOn(Client.prototype, "query").mockImplementation(function (this: Client, ...args: unknown[]) {
    if (isIdleValidationProbe(args[0])) idleProbes += 1;
    else dispatches += 1;
    return (original as (...input: unknown[]) => unknown).apply(this, args);
  } as typeof Client.prototype.query);
  return {
    take: (): { dispatches: number; idleProbes: number } => {
      const taken = { dispatches, idleProbes };
      dispatches = 0;
      idleProbes = 0;
      spy.mockClear();
      return taken;
    },
    restore: () => { spy.mockRestore(); },
  };
}

type DispatchCounter = ReturnType<typeof countDispatches>;

async function measure<T>(
  relay: RoundTripRelay,
  counter: DispatchCounter,
  run: () => Promise<T>,
): Promise<{ readonly outcome: T; readonly counts: StepCounts }> {
  await relay.quiescent();
  const before = relay.counts();
  counter.take();
  const outcome = await run();
  // Every step closes its pools; their teardown belongs to the step.
  await relay.quiescent();
  const after = relay.counts();
  return {
    outcome,
    counts: {
      turns: after.turns - before.turns,
      connections: after.connections - before.connections,
      ...counter.take(),
    },
  };
}

/** Turns one connection costs beyond its SQL: TLS, authentication and teardown. */
async function connectionTurns(relay: RoundTripRelay, connection: PostgreSqlConnectionSettings): Promise<number> {
  await relay.quiescent();
  const before = relay.counts().turns;
  const runtime = new PostgreSqlRuntime({ ...connection, poolMax: 1 });
  try {
    await runtime.query({ text: "SELECT 1" }, { domain: "factory", operation: "roundTripConnectionTurns" });
  } finally {
    await runtime.close();
  }
  await relay.quiescent();
  return relay.counts().turns - before - 1;
}

function presentPresence() {
  return { status: "present" as const, storageBackend: "sqlite", pid: 1, daemonInstanceId: "migration-round-trip-budget" };
}

async function prepareMigrationSource(home: string, transfer: PostgreSqlConnectionSettings): Promise<string> {
  const cwd = join(home, "project");
  mkdirSync(cwd, { mode: 0o700 });
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const local = resolveProjectIdentity(cwd);
  vi.unstubAllEnvs();
  const projectDir = join(home, ".lcm", "projects", local.id);
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, ".lcm", "events"), { mode: 0o700 });
  writeFileSync(join(projectDir, "meta.json"), JSON.stringify({ cwd }) + "\n", { mode: 0o600 });
  await prepareSqliteMigrationEnrollment({
    cwd,
    homeDir: home,
    targetConfig: {
      backend: "postgresql",
      postgresql: {
        ...transfer,
        snapshotIdleTimeoutMs: transfer.snapshotIdleTimeoutMs ?? DEFAULT_SNAPSHOT_IDLE_TIMEOUT_MS,
        migrationRole: EXPECTED_OWNER,
      },
    },
  });
  writeFileSync(configPath(home), JSON.stringify({
    daemon: { port: DAEMON_PORT },
    storage: {
      backend: "sqlite",
      postgresql: {
        migrationRole: EXPECTED_OWNER,
        poolMax: transfer.poolMax,
        connectionTimeoutMs: transfer.connectionTimeoutMs,
        idleTimeoutMs: transfer.idleTimeoutMs,
        statementTimeoutMs: transfer.statementTimeoutMs,
      },
    },
  }) + "\n", { mode: 0o600 });
  return cwd;
}

describe("migration round-trip budget (#1869)", () => {
  it("runs plan, apply, verify and activate within their recorded exchange budgets", async () => {
    await withPostgreSqlTestDatabase("round-trip-budget", async (db) => {
      const relay = await startRoundTripRelay(postgreSqlUrlTarget(db.runtimeUrl));
      const counter = countDispatches();
      const home = mkdtempSync(join(tmpdir(), "migration-round-trip-budget-"));
      try {
        const roles = await provisionActivationRole(db);
        const through = (connection: PostgreSqlConnectionSettings): PostgreSqlConnectionSettings => ({
          ...connection, url: viaRoundTripRelay(connection.url, relay), poolMax: POOL_MAX, idleTimeoutMs: IDLE_TIMEOUT_MS,
        });
        const transfer = through(roles.transfer);
        const perConnection = await connectionTurns(relay, transfer);
        const cwd = await prepareMigrationSource(home, transfer);
        vi.stubEnv("LCM_POSTGRES_URL", transfer.url);
        vi.stubEnv("LCM_POSTGRES_CA_FILE", transfer.caFile);
        const preflight = () => resolveMigrationPreflight({
          cwd, homeDir: home, _operationsForTesting: { classifyPresence: async () => presentPresence() },
        });
        const counts: Partial<Record<Step, StepCounts>> = {};

        const plan = await measure(relay, counter, () => performMigrationPlan({ cwd, homeDir: home, _preflight: preflight }));
        counts.plan = plan.counts;
        expect(plan.outcome).toMatchObject({ status: "ok" });
        if (plan.outcome.status !== "ok") throw new Error("plan did not return a generation");
        const generationId = plan.outcome.generationId;

        const apply = await measure(relay, counter, () => performMigrationApply({
          cwd, homeDir: home, confirmGenerationId: generationId, _preflight: preflight,
        }));
        counts.apply = apply.counts;
        expect(apply.outcome).toMatchObject({ status: "ok", applied: true, phase: "copied" });

        const common = { cwd, homeDir: home, generation: generationId, confirmGenerationId: generationId };
        const verify = await measure(relay, counter, () => performMigrationVerifyCommand(common));
        counts.verify = verify.counts;
        expect(verify.outcome).toMatchObject({ status: "ok", applied: true, manifestPhase: "verified" });

        await grantRuntimeActivationRole(db, roles.transfer);
        vi.stubEnv("LCM_POSTGRES_RUNTIME_URL", through(roles.runtime).url);
        const activate = await measure(relay, counter, () => performMigrationActivateCommand({
          ...common, confirmBackend: "postgresql",
        }));
        counts.activate = activate.counts;
        expect(activate.outcome).toMatchObject({ status: "ok", applied: true, manifestPhase: "active" });

        const report = JSON.stringify({ perConnection, counts });
        for (const step of STEPS) {
          const measured = counts[step]!;
          const budget = MEASURED[step];
          expect(measured.dispatches, step + " dispatches " + report).toBeLessThanOrEqual(budget.dispatches + budget.connections);
          expect(measured.turns - measured.idleProbes, step + " turns " + report)
            .toBeLessThanOrEqual(budget.turns + budget.connections * perConnection);
        }
      } finally {
        counter.restore();
        closeLcmConnection();
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
        await relay.close();
        await dropActivationRole(db);
      }
    });
  }, 300_000);
});
