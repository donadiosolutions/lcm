import type { DaemonConfig, ResolvedPostgreSqlConfig } from "./config.js";
import type {
  PassiveEventReplicationDependencies,
  PassiveEventReplicationResult,
} from "./passive-event-replication.js";
import type { LocalHookOutboxRepository } from "../storage/local-hook-outbox.js";
import type { StoredMachineIdentity } from "../machine-identity.js";
import type { BackgroundPublicationAdmission } from "./passive-event-processor.js";
import {
  BackendPublicationAppendBarrierTimeoutError,
  BackendPublicationJournalError,
  withBackendPublicationAppendBarrierAsync,
  type BackendPublicationLockToken,
} from "../storage/backend-publication.js";
import { safeLogError } from "../hooks/hook-errors.js";
import type { PostgreSqlPassiveEventRepository } from "../storage/postgresql/passive-event-repository.js";
import type { ScrubEngine } from "../scrub.js";

/**
 * Applying a claimed passive event performs no additional remote work.
 *
 * The inbox row is itself the delivery artifact. Memory promotion happens
 * locally through `promoteEventsForCwd` against the daemon's selected
 * PostgreSQL project storage, and `docs/passive-learning.md` describes this
 * worker as distinct from that route consumer, so an event is fully delivered
 * once its inbox row is durably `applied`. The `applied` transition is
 * therefore the terminal outcome, and no remote-side effect is intended. This
 * hook exists so that any future effect would share the `applied`
 * transaction; adding one would be a new feature, not a missing piece.
 *
 * This is a deliberate decision rather than an unfinished one.
 */
export async function applyReplicatedPassiveEvent(): Promise<void> {
  return undefined;
}

interface RuntimeLike {
  health(signal?: AbortSignal): Promise<{ status: string; error?: Error }>;
  close(): Promise<void>;
}

interface OutboxFactoryLike {
  openExisting(dbPath: string): Promise<LocalHookOutboxRepository | null>;
  close(): Promise<void>;
}

/**
 * The project's remote binding changed, or disappeared, after the pass
 * resolved it (#1473). It is a plain error on purpose: it belongs to this
 * project's pass, so the pass reports it once and keeps running instead of
 * letting it halt the sweep like a publication failure would.
 */
export class ReplicationBindingChangedError extends Error {
  constructor(cwd: string) {
    super(
      `the remote project binding of ${cwd} changed during the pass; `
      + "it uploads no further rows to the previous project",
    );
    this.name = "ReplicationBindingChangedError";
  }
}

interface WorkerLike {
  runOnce(signal?: AbortSignal): Promise<PassiveEventReplicationResult>;
}

export interface PassiveEventReplicationModules {
  readonly ensureWorktreeProjectReconciled: (cwd: string) => unknown;
  readonly resolveProjectIdentity: (cwd: string) => { readonly remoteProjectId?: string | null };
  readonly readMachineIdentity: () => StoredMachineIdentity | null;
  /**
   * Read-only re-resolution of the persisted binding; it never creates or
   * publishes a project-map entry.
   */
  readonly resolveExistingProjectIdentity: (
    cwd: string,
    publicationLockToken?: BackendPublicationLockToken,
  ) => { readonly remoteProjectId?: string | null } | null;
  readonly createRuntime: (settings: ResolvedPostgreSqlConfig["postgresql"]) => RuntimeLike;
  readonly createOutboxFactory: () => OutboxFactoryLike;
  readonly loadScrubber: (cwd: string, globalPatterns: string[]) => Promise<ScrubEngine>;
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
  /**
   * Publication admission the pass admits each replication phase through.
   * Every admission re-checks the frozen startup backend, so a publication
   * switch between phases refuses the next one and halts the pass (#1384).
   * Without it the worker runs unadmitted, as a standalone worker would.
   */
  readonly withPublicationAdmission?: BackgroundPublicationAdmission;
  /**
   * Publication home whose consumer lock each phase admission holds. The
   * append barrier around the admitted token is what keeps the phase-local
   * outbox usable inside its own admission window.
   */
  readonly publicationHome?: string;
  readonly loadModules?: () => Promise<PassiveEventReplicationModules>;
  readonly onError?: (error: unknown) => void | Promise<void>;
  readonly createWorker?: (
    dependencies: PassiveEventReplicationDependencies,
    processId: string,
  ) => WorkerLike;
}

export interface PassiveEventReplicationPass {
  /**
   * Returns null when replication is not applicable to this project.
   * `sidecarPath` is the events database the sweep scanned for `cwd`: the
   * pass opens exactly that file and never derives or creates another (#1488).
   */
  run(
    cwd: string,
    signal: AbortSignal | undefined,
    sidecarPath: string,
  ): Promise<PassiveEventReplicationResult | null>;
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
}

/** Bind imported namespaces to the seams the pass calls. */
export function buildReplicationModules(
  imported: PassiveEventReplicationImports,
): PassiveEventReplicationModules {
  return {
    ensureWorktreeProjectReconciled: imported.reconciliation.ensureWorktreeProjectReconciled,
    resolveProjectIdentity: imported.projectMap.resolveProjectIdentity,
    readMachineIdentity: imported.identity.readMachineIdentity,
    resolveExistingProjectIdentity: imported.projectMap.resolveExistingProjectIdentity,
    createRuntime: settings => new imported.runtime.PostgreSqlRuntime(settings),
    createOutboxFactory: () => new imported.outbox.SQLiteLocalHookOutboxFactory(),
    loadScrubber: async (cwd, globalPatterns) => {
      const [{ ScrubEngine }, { projectDir }] = await Promise.all([
        import("../scrub.js"), import("./project.js"),
      ]);
      return ScrubEngine.forProject(globalPatterns, projectDir(cwd));
    },
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
  const [projectMap, reconciliation, identity, replication, runtime, repository, outbox] =
    await Promise.all([
      import("../project-map.js"),
      import("../worktree-reconciliation.js"),
      import("../machine-identity.js"),
      import("./passive-event-replication.js"),
      import("../storage/postgresql/runtime.js"),
      import("../storage/postgresql/passive-event-repository.js"),
      import("../storage/local-hook-outbox.js"),
    ]);
  return buildReplicationModules({
    projectMap, reconciliation, identity, replication, runtime, repository, outbox,
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
  let factoryCloseFailed = false;
  // Repositories whose close rejected, by sidecar path: at most one per path.
  const retained = new Map<string, LocalHookOutboxRepository>();

  return {
    async run(cwd, signal, sidecarPath) {
      // Gate 1: a SQLite daemon never loads a PostgreSQL module at all.
      const storage = config.storage;
      if (storage.backend !== "postgresql") return null;
      // A factory whose close failed is closed to new opens and still owns
      // its repositories until a later close() succeeds, so opening through
      // it, or beside it, would only add connections.
      if (factoryCloseFailed) return null;
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

        outboxFactory ??= loaded.createOutboxFactory();
        // A repository whose close failed on an earlier pass is closed again
        // before this path is opened, so each sidecar keeps at most one open
        // outbox (#1478). Any failure here, publication errors included,
        // belongs to this project's retry rather than to the daemon.
        const stale = retained.get(sidecarPath);
        if (stale !== undefined) {
          try {
            await stale.close();
            retained.delete(sidecarPath);
          } catch (error) {
            await report(error);
            return null;
          }
        }
        // The sweep already scanned and promoted this exact sidecar, so open
        // it as it is: never derive another path, never create a file. A
        // sidecar that is gone resolves no project identity at all, because
        // resolving one can create and publish a project-map entry (#1510).
        const local = await outboxFactory.openExisting(sidecarPath);
        if (local === null) return null;
        // Everything below runs while the opened outbox is held, so every
        // way out of it, a skipped gate or a thrown error included, releases
        // that outbox. The factory registers every repository it opens and
        // only releases one when that repository closes, so a sweep that kept
        // its outbox would add a SQLite connection per project every five
        // minutes for the life of the daemon. Releasing cannot fail the pass:
        // the durable work is already committed by the time we get here. A
        // repository that refuses to close is kept for the next pass's retry
        // instead of being dropped while the factory still holds it.
        try {
          // Gate 3: the project must be bound to a remote project id.
          // Reconcile first so a linked worktree resolves to its canonical
          // binding.
          loaded.ensureWorktreeProjectReconciled(cwd);
          const remoteProjectId = loaded.resolveProjectIdentity(cwd).remoteProjectId ?? null;
          if (remoteProjectId === null) return null;
          const scrubber = await loaded.loadScrubber(cwd, config.security.sensitivePatterns);

          // Gate 4: refuse to claim a lease against unhealthy storage.
          runtime ??= loaded.createRuntime(storage.postgresql);
          const health = await runtime.health(signal);
          if (health.status !== "healthy") {
            await report(health.error ?? new Error("PostgreSQL passive-event storage is unavailable"));
            return null;
          }

          // The remote repository is bound to one project id for the whole
          // pass. Each admitted phase re-reads the persisted binding before
          // it touches that repository until it sees the binding move
          // (#1473). From then on the pass sends no new local row to the
          // previous project and withdraws no row from other projects, but
          // it keeps completing what that project already holds instead of
          // abandoning it mid-pass. Rows still awaiting the previous project
          // when the pass ends are recovered by the next pass, which is bound
          // to the new project (#1509). The check is read-only. Where the
          // admission supplies a token it reads under that token; the
          // publication home is assumed to equal the project-map home, as it
          // is for the daemon (both homedir()). Without an admission there is
          // no lock to be atomic with, so the check is best effort.
          let bindingChanged = false;
          const checkBinding = async (
            publicationLockToken?: BackendPublicationLockToken,
          ): Promise<void> => {
            if (bindingChanged) return;
            const current = loaded.resolveExistingProjectIdentity(cwd, publicationLockToken);
            if (current === null || (current.remoteProjectId ?? null) !== remoteProjectId) {
              bindingChanged = true;
              await report(new ReplicationBindingChangedError(cwd));
            }
          };
          // The worker's view of the outbox. Every method reaches the real
          // repository with the repository as receiver; once the binding
          // moved, claiming new deliveries resolves empty without touching
          // the database, so those rows stay pending for the new binding.
          const guarded = new Proxy(local, {
            get: (target, property) => {
              if (property === "claimDeliveries" && bindingChanged) return async () => [];
              const value: unknown = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          // The worker's view of the remote repository, guarded the same
          // way: once the binding moved it is still bound to the previous
          // project, so withdrawing rows from "other" projects would be
          // decided against a stale binding. That recovery then resolves with
          // no outcomes and waits for the next pass. A binding move inside
          // the call itself is accepted: the call only releases this
          // machine's own, envelope-matched rows, which re-upload to the new
          // binding.
          const bound = loaded.createRepository(runtime, remoteProjectId, identity.machineId);
          const remote = new Proxy(bound, {
            get: (target, property) => {
              if (property === "releaseFromOtherProjects" && bindingChanged) {
                return async () => [];
              }
              const value: unknown = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          // Each worker phase runs under its own publication admission so the
          // consumer lock is released between phases and hook appends can
          // proceed. Without an admission the phases run directly, as a
          // standalone worker would.
          const admit = options.withPublicationAdmission;
          const admitPhase: PassiveEventReplicationDependencies["admitPhase"] =
            admit === undefined
              ? async operation => {
                await checkBinding();
                return operation();
              }
              : async operation => admit(
                async publicationLockToken => {
                  await checkBinding(publicationLockToken);
                  return withBackendPublicationAppendBarrierAsync(
                    options.publicationHome,
                    () => operation(),
                    publicationLockToken,
                  );
                },
              );
          const dependencies: PassiveEventReplicationDependencies = {
            local: guarded,
            remote,
            applyEvent: applyReplicatedPassiveEvent,
            onError: report,
            admitPhase,
            scrubber,
          };
          const createWorker = options.createWorker ?? loaded.createWorker;
          const worker = createWorker(dependencies, options.processId);
          return await worker.runOnce(signal);
        } finally {
          try {
            await local.close();
          } catch (error) {
            retained.set(sidecarPath, local);
            await report(error);
          }
        }
      } catch (error) {
        // Publication admission and barrier failures belong to the daemon,
        // not to this project: rethrow them so the sweep logs them with
        // the project and halts on a frozen-backend mismatch, exactly as a
        // direct admission failure would. Every other failure is reported
        // and skipped like any other unusable project.
        if (error instanceof BackendPublicationJournalError
          || error instanceof BackendPublicationAppendBarrierTimeoutError) {
          throw error;
        }
        await report(error);
        return null;
      }
    },
    async close() {
      const closing = [outboxFactory?.close(), runtime?.close()];
      runtime = null;
      modules = null;
      const settled = await Promise.allSettled(closing);
      // The factory closes every repository it registered, retained ones
      // included, so it and the retained set are released together and only
      // once that close succeeded. A failed close keeps both for a retry.
      if (settled[0].status === "fulfilled") {
        outboxFactory = null;
        retained.clear();
        factoryCloseFailed = false;
      } else {
        factoryCloseFailed = true;
      }
      for (const outcome of settled) {
        if (outcome.status === "rejected") await report(outcome.reason);
      }
    },
  };
}
