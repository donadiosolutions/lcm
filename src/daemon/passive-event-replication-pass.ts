import type { DaemonConfig, ResolvedPostgreSqlConfig } from "./config.js";
import type {
  PassiveEventReplicationDependencies,
  PassiveEventReplicationResult,
} from "./passive-event-replication.js";
import type { LocalHookOutboxRepository } from "../storage/local-hook-outbox.js";
import type { StoredMachineIdentity } from "../machine-identity.js";
import { safeLogError } from "../hooks/hook-errors.js";
import type { PostgreSqlPassiveEventRepository } from "../storage/postgresql/passive-event-repository.js";

/**
 * Applying a claimed passive event performs no additional remote work.
 *
 * The inbox row is itself the delivery artifact. Memory promotion happens
 * locally through `promoteEventsForCwd` against the daemon's selected
 * PostgreSQL project storage, and `docs/passive-learning.md` describes this
 * worker as distinct from that route consumer, so an event is fully delivered
 * once its inbox row is durably `applied`. The `applied` transition is
 * therefore the terminal outcome and this hook exists only so the transition
 * and any future effect share one short transaction.
 *
 * This is a deliberate decision rather than an unfinished one. Whether #91
 * intended a real remote-side effect here is tracked in issue #1398.
 */
export async function applyReplicatedPassiveEvent(): Promise<void> {
  return undefined;
}

interface RuntimeLike {
  health(): Promise<{ status: string; error?: Error }>;
  close(): Promise<void>;
}

interface OutboxFactoryLike {
  open(dbPath: string): Promise<LocalHookOutboxRepository>;
  close(): Promise<void>;
}

interface WorkerLike {
  runOnce(signal?: AbortSignal): Promise<PassiveEventReplicationResult>;
}

export interface PassiveEventReplicationModules {
  readonly ensureWorktreeProjectReconciled: (cwd: string) => unknown;
  readonly resolveProjectIdentity: (cwd: string) => { readonly remoteProjectId?: string | null };
  readonly readMachineIdentity: () => StoredMachineIdentity | null;
  readonly eventsDbPath: (cwd: string) => string;
  readonly createRuntime: (settings: ResolvedPostgreSqlConfig["postgresql"]) => RuntimeLike;
  readonly createOutboxFactory: () => OutboxFactoryLike;
  readonly createRepository: (
    runtime: RuntimeLike,
    projectId: string,
    machineId: string,
  ) => PostgreSqlPassiveEventRepository;
  /**
   * The worker is reached through the bundle so this module's own static
   * graph stops at the daemon: `passive-event-replication.js` imports the
   * PostgreSQL repository as a value, and `server.ts` imports this file
   * statically, so a static worker import would load PostgreSQL storage into
   * every SQLite daemon before gate 1 ever runs.
   */
  readonly createWorker: (
    dependencies: PassiveEventReplicationDependencies,
    processId: string,
  ) => WorkerLike;
}

export interface PassiveEventReplicationPassOptions {
  /** Lease owner identity; the daemon instance id keeps fencing aligned. */
  readonly processId: string;
  readonly loadModules?: () => Promise<PassiveEventReplicationModules>;
  readonly onError?: (error: unknown) => void | Promise<void>;
  readonly createWorker?: (
    dependencies: PassiveEventReplicationDependencies,
    processId: string,
  ) => WorkerLike;
}

export interface PassiveEventReplicationPass {
  /** Returns null when replication is not applicable to this project. */
  run(cwd: string, signal?: AbortSignal): Promise<PassiveEventReplicationResult | null>;
  close(): Promise<void>;
}

/** The module namespaces the pass needs; separated so wiring stays testable. */
export interface PassiveEventReplicationImports {
  readonly projectMap: typeof import("../project-map.js");
  readonly reconciliation: typeof import("../worktree-reconciliation.js");
  readonly identity: typeof import("../machine-identity.js");
  readonly replication: typeof import("./passive-event-replication.js");
  readonly runtime: typeof import("../storage/postgresql/runtime.js");
  readonly repository: typeof import("../storage/postgresql/passive-event-repository.js");
  readonly outbox: typeof import("../storage/local-hook-outbox.js");
  readonly paths: typeof import("../db/events-path.js");
}

/** Bind imported namespaces to the seams the pass calls. */
export function buildReplicationModules(
  imported: PassiveEventReplicationImports,
): PassiveEventReplicationModules {
  return {
    ensureWorktreeProjectReconciled: imported.reconciliation.ensureWorktreeProjectReconciled,
    resolveProjectIdentity: imported.projectMap.resolveProjectIdentity,
    readMachineIdentity: imported.identity.readMachineIdentity,
    eventsDbPath: imported.paths.eventsDbPath,
    createRuntime: settings => new imported.runtime.PostgreSqlRuntime(settings),
    createOutboxFactory: () => new imported.outbox.SQLiteLocalHookOutboxFactory(),
    createRepository: (executor, projectId, machineId) =>
      new imported.repository.PostgreSqlPassiveEventRepository(
        executor as never,
        projectId,
        machineId,
      ),
    createWorker: (dependencies, processId) =>
      new imported.replication.PassiveEventReplicationWorker(dependencies, { processId }),
  };
}

/** PostgreSQL modules load only on a daemon that actually replicates. */
export async function loadReplicationModules(): Promise<PassiveEventReplicationModules> {
  const [projectMap, reconciliation, identity, replication, runtime, repository, outbox, paths] =
    await Promise.all([
      import("../project-map.js"),
      import("../worktree-reconciliation.js"),
      import("../machine-identity.js"),
      import("./passive-event-replication.js"),
      import("../storage/postgresql/runtime.js"),
      import("../storage/postgresql/passive-event-repository.js"),
      import("../storage/local-hook-outbox.js"),
      import("../db/events-path.js"),
    ]);
  return buildReplicationModules({
    projectMap, reconciliation, identity, replication, runtime, repository, outbox, paths,
  });
}

/**
 * Build the daemon-owned passive-event replication pass (#1383).
 *
 * The worker shipped with no production caller, so `markReplicated` and
 * `markRemotePruned` were unreachable and a PostgreSQL install could never
 * advance an event to a prunable state. The sweep drives this pass per
 * sidecar because replication is inherently per-project: the remote repository
 * is bound to one project id and the local outbox to one events database.
 *
 * A daemon that cannot replicate must behave exactly as it did before, without
 * loading a PostgreSQL module or opening a connection. Gates 1 to 3 are
 * therefore quiet skips over states an operator has simply not configured;
 * only gate 4 and an unreadable machine.json report, because those are faults.
 */
export function createPassiveEventReplicationPass(
  config: DaemonConfig,
  options: PassiveEventReplicationPassOptions,
): PassiveEventReplicationPass {
  const loadModules = options.loadModules ?? loadReplicationModules;
  const onError = options.onError
    ?? (async (error: unknown) => { await safeLogError("passive-event-replication", error, {}); });
  const report = async (error: unknown): Promise<void> => {
    try {
      await onError(error);
    } catch {
      // Diagnostics must never displace durable replication work.
    }
  };
  let modules: Promise<PassiveEventReplicationModules> | null = null;
  let runtime: RuntimeLike | null = null;
  let outboxFactory: OutboxFactoryLike | null = null;

  return {
    async run(cwd, signal) {
      // Gate 1: a SQLite daemon never loads a PostgreSQL module at all.
      const storage = config.storage;
      if (storage.backend !== "postgresql") return null;
      try {
        modules ??= loadModules();
        const loaded = await modules;

        // Gate 2: a registered machine identity owns the local outbox rows.
        // A machine that was never registered, or whose registration was
        // interrupted, is unconfigured rather than broken, so it skips as
        // quietly as an unbound project instead of emitting one diagnostic
        // per sidecar per sweep forever. A machine.json that exists but
        // cannot be read still throws out to the reporter below.
        const identity = loaded.readMachineIdentity();
        if (identity === null || identity.machineId === null) return null;

        // Gate 3: the project must be bound to a remote project id. Reconcile
        // first so a linked worktree resolves to its canonical binding.
        loaded.ensureWorktreeProjectReconciled(cwd);
        const remoteProjectId = loaded.resolveProjectIdentity(cwd).remoteProjectId ?? null;
        if (remoteProjectId === null) return null;

        // Gate 4: refuse to claim a lease against unhealthy storage.
        runtime ??= loaded.createRuntime(storage.postgresql);
        const health = await runtime.health();
        if (health.status !== "healthy") {
          await report(health.error ?? new Error("PostgreSQL passive-event storage is unavailable"));
          return null;
        }

        outboxFactory ??= loaded.createOutboxFactory();
        const local = await outboxFactory.open(loaded.eventsDbPath(cwd));
        try {
          const remote = loaded.createRepository(runtime, remoteProjectId, identity.machineId);
          const dependencies: PassiveEventReplicationDependencies = {
            local,
            remote,
            applyEvent: applyReplicatedPassiveEvent,
            onError: report,
          };
          const createWorker = options.createWorker ?? loaded.createWorker;
          const worker = createWorker(dependencies, options.processId);
          return await worker.runOnce(signal);
        } finally {
          // The factory registers every repository it opens and only releases
          // one when that repository closes, so a sweep that kept its outbox
          // would add a SQLite connection per project every five minutes for
          // the life of the daemon. Releasing here cannot fail the pass: the
          // durable work is already committed by the time we get here.
          try {
            await local.close();
          } catch (error) {
            await report(error);
          }
        }
      } catch (error) {
        await report(error);
        return null;
      }
    },
    async close() {
      const closing = [outboxFactory?.close(), runtime?.close()];
      outboxFactory = null;
      runtime = null;
      modules = null;
      const settled = await Promise.allSettled(closing);
      for (const outcome of settled) {
        if (outcome.status === "rejected") await report(outcome.reason);
      }
    },
  };
}
