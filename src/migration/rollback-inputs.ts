import { join } from "node:path";
import { readDaemonConfigSnapshot, type ResolvedStorageConfig } from "../daemon/config.js";
import { requireMachineIdentity } from "../machine-identity.js";
import { readProjectMapSnapshot } from "../project-map.js";
import type { BackendMaintenanceRosterEntry, BackendPublicationCoordinator } from "../storage/backend-publication.js";
import { connectionSettings } from "../storage/postgresql/factory.js";
import { resolveStorageIdentityContext } from "../storage/identity-context.js";
import type { PortableProjectIdentity } from "../storage/portable-record-stream.js";
import { BackendPublicationJournalError } from "../storage/backend-publication.js";
import { createBackendPublicationCoordinator } from "../storage/backend-publication-driver.js";
import { createPostgreSqlBackendPublicationRemoteGuard } from "../storage/postgresql/publication-remote-guard.js";
import { MigrationBindingUnresolvableError } from "./generation-binding-store.js";
import { MigrationManifestStore } from "./manifest-store.js";
import type { MigrationManifest } from "./protocol.js";
import { inspectAuthenticatedSqliteMigrationSnapshot } from "./queue-evidence.js";
import {
  DEFAULT_ROLLBACK_SESSION_DEPENDENCIES,
  ROLLBACK_LEASE_TTL_MS,
  RollbackSessionError,
  openRollbackFencedSession,
  type RollbackSessionDependencies,
  type RollbackSessionRuntime,
  type RollbackSessionTarget,
} from "./rollback-session.js";
import {
  RollbackOrchestrationError,
  deriveRollbackPublicationId,
  readOwnPublicationSourceFromMaterial,
  readProjectMapForRollback,
  runMigrationRollback,
  type OwnPublicationSource,
  type RunMigrationRollbackDependencies,
  type RunMigrationRollbackInput,
  type RunMigrationRollbackOutcome,
} from "./rollback.js";

/**
 * Derives a rollback's inputs from durable state (plan-v3.1 amendment A12),
 * so the CLI passes only a home directory and a generation id. Nothing
 * here is invented by a caller.
 *
 * Sources, all read from what the forward migration left behind:
 *
 *  - The manifest names the preserved source generation; its immutable
 *    #622 snapshot artifact (and the queue evidence sealed beside it) carry
 *    the project's physical id (the local project id), its live database
 *    path (the path rollback installs into -- not the project directory),
 *    and the values the forward capture bound into its maintenance journal.
 *  - The project map binds the local project to its PostgreSQL project id,
 *    which gives the shared project identity the export is built under.
 *    An unbound project refuses.
 *  - The daemon configuration supplies the PostgreSQL target; it must still
 *    select PostgreSQL, because rollback unwinds an activated backend.
 *
 * Rollback records sourceSelectionSha256, queueEvidenceSha256 and the roster
 * row as lineage evidence of the generation it unwinds, not as a fresh
 * cutoff, and it seals no queue evidence of its own. The values are only
 * format-checked by enterMaintenance and the quiescence check (which also
 * requires a single-machine roster); the one place a roster is read
 * semantically is the forward copy source (copy-source.ts), which rollback
 * never runs.
 */

export type RollbackInputResolutionReason =
  | "backend-not-postgresql"
  | "machine-mismatch"
  | "project-unbound";

export class RollbackInputResolutionError extends Error {
  constructor(readonly reason: RollbackInputResolutionReason, message: string) {
    super(message);
    this.name = "RollbackInputResolutionError";
  }
}

export type ResolvedMigrationRollbackContext = Readonly<{
  /** The input runMigrationRollback takes, minus the per-call scratchParent and signal. */
  input: Pick<
    RunMigrationRollbackInput,
    | "homeDir" | "generationId" | "canonicalPath" | "projectIdentity" | "localProjectId"
    | "sourceSelectionSha256" | "queueEvidenceSha256" | "roster"
  >;
  /** The fenced session's target (createMigrationRollbackDependencies consumes it). */
  target: RollbackSessionTarget;
}>;

/** The durable-state readers resolveMigrationRollbackContext uses; injectable for tests. */
export interface ResolveRollbackContextDependencies {
  readManifest(homeDir: string, generationId: string): MigrationManifest;
  inspectSnapshot: typeof inspectAuthenticatedSqliteMigrationSnapshot;
  requireMachineIdentity: typeof requireMachineIdentity;
  readStorageConfig(homeDir: string): ResolvedStorageConfig;
  readProjectMap: typeof readProjectMapSnapshot;
  resolveIdentity: typeof resolveStorageIdentityContext;
  /**
   * The configuration and project map as they were before this rollback's own publication, read from the
   * publication's authenticated recovery material, or null when no such publication is in the live slot.
   * Once the rollback's publication has begun, the live files and the consumer read are the rollback's
   * in-flight state, so a re-run resolves its inputs from the material that publication sealed.
   */
  readOwnPublicationSource(homeDir: string, publicationId: string, localProjectId: string): OwnPublicationSource | null;
}

export const DEFAULT_RESOLVE_ROLLBACK_CONTEXT_DEPENDENCIES: ResolveRollbackContextDependencies = {
  readManifest: (homeDir, generationId) => new MigrationManifestStore({ homeDir }).read(generationId),
  inspectSnapshot: inspectAuthenticatedSqliteMigrationSnapshot,
  requireMachineIdentity,
  readStorageConfig: (homeDir) => readDaemonConfigSnapshot(join(homeDir, ".lcm", "config.json")).config.storage,
  readProjectMap: readProjectMapForRollback,
  resolveIdentity: resolveStorageIdentityContext,
  readOwnPublicationSource: readOwnPublicationSourceFromMaterial,
};

export async function resolveMigrationRollbackContext(
  request: Readonly<{ homeDir: string; generationId: string }>,
  dependencies: ResolveRollbackContextDependencies = DEFAULT_RESOLVE_ROLLBACK_CONTEXT_DEPENDENCIES,
): Promise<ResolvedMigrationRollbackContext> {
  const { homeDir, generationId } = request;
  const manifest = dependencies.readManifest(homeDir, generationId);
  const preservedSourceGenerationId = manifest.rollbackLineage.preservedSourceGenerationId;
  const evidence = await dependencies.inspectSnapshot(preservedSourceGenerationId, homeDir);
  const artifact = evidence.artifact;
  const authority = artifact.authority;

  const machine = dependencies.requireMachineIdentity(homeDir);
  if (authority.machineIdentity.machineId !== machine.machineId) {
    throw new RollbackInputResolutionError(
      "machine-mismatch",
      "the forward capture's participant machine is not this machine; rollback runs on the machine that migrated",
    );
  }
  const roster: readonly BackendMaintenanceRosterEntry[] = [{
    machineId: authority.machineIdentity.machineId,
    queueCutoff: evidence.receiptReference.queueCutoff,
    evidenceSha256: artifact.sourceByteWitnessSha256,
  }];

  const own = dependencies.readOwnPublicationSource(homeDir, deriveRollbackPublicationId(generationId), authority.physicalProjectId);
  const storage = own === null ? dependencies.readStorageConfig(homeDir) : own.storage;
  if (storage.backend !== "postgresql") {
    throw new RollbackInputResolutionError(
      "backend-not-postgresql",
      "rollback unwinds an activated PostgreSQL backend, but the configuration selects another; a generation that "
        + "never activated is left with lcm migration abort",
    );
  }
  const entry = (own === null ? dependencies.readProjectMap(homeDir) : own.projectMap)[authority.physicalProjectId];
  if (entry?.remoteProjectId === undefined) {
    // Owner decision (against coordinator-seam-FROZEN.md section 12's "answer rather than defer to abort"): a
    // generation that never activated has no project-map binding, because activation's publication is what
    // binds the project, and no durable local source holds its PostgreSQL id before that (copy-source.ts
    // receives the id from the caller and does not persist it, and the PostgreSQL identity repository is
    // circular for a lease that needs the id first). Rollback therefore cannot start for it; the operator
    // leaves through "lcm migration abort", which the protocol permits from planned through verified.
    throw new RollbackInputResolutionError(
      "project-unbound",
      "the project has no PostgreSQL binding in the project map, so this generation never activated and there is "
        + "nothing to roll back from; run lcm migration abort to leave it",
    );
  }
  const remoteProjectId = entry.remoteProjectId;
  const expectedIdentity = dependencies.resolveIdentity(
    storage,
    { id: authority.physicalProjectId, canonical: entry.canonical, remoteProjectId },
    homeDir,
    entry.canonical,
  );
  const projectIdentity: PortableProjectIdentity = { scope: "shared", projectId: remoteProjectId };

  return {
    input: {
      homeDir,
      generationId,
      canonicalPath: authority.projectDbPath,
      projectIdentity,
      localProjectId: authority.physicalProjectId,
      sourceSelectionSha256: artifact.sourceSelectionSha256,
      queueEvidenceSha256: artifact.queueEvidenceSha256,
      roster,
    },
    target: {
      settings: connectionSettings(storage),
      expectedOwner: storage.postgresql.migrationRole,
      expectedIdentity,
      localProjectId: authority.physicalProjectId,
      remoteProjectId,
      machineId: machine.machineId,
    },
  };
}

/**
 * The production dependencies of runMigrationRollback. Binding writers, the
 * binding and evidence readers and the context fetch are the orchestration's
 * own defaults; this supplies the fenced session. The coordinator is built
 * by runMigrationRollbackFromHome from the session's own runtime.
 */
export function createMigrationRollbackDependencies(input: Readonly<{
  coordinator: BackendPublicationCoordinator;
  target: RollbackSessionTarget;
  sessionDependencies?: RollbackSessionDependencies;
}>): RunMigrationRollbackDependencies {
  return {
    coordinator: input.coordinator,
    openFencedSession: (request) => openRollbackFencedSession(request, input.target, input.sessionDependencies),
  };
}


// ---------------------------------------------------------------------------
// The production entry. #627's CLI calls only this.
// ---------------------------------------------------------------------------

/** Why a production rollback ended without completing; the closed list #627 maps to its messages and exit codes. */
export const MIGRATION_ROLLBACK_ERROR_REASONS = [
  "not-eligible",
  "unresolvable",
  "lease-lost",
  "quiescence-unsatisfied",
  "drift",
  "input-unresolvable",
  "unexpected-state",
] as const;

export type MigrationRollbackErrorReason = (typeof MIGRATION_ROLLBACK_ERROR_REASONS)[number];

/**
 * The one error the production entry throws. Every typed error of the
 * modules it composes is mapped to a reason; the original message is kept
 * and the original error is the cause, so nothing is lost.
 */
export class MigrationRollbackError extends Error {
  constructor(readonly reason: MigrationRollbackErrorReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MigrationRollbackError";
  }
}

function rollbackErrorReason(error: unknown): MigrationRollbackErrorReason {
  if (error instanceof RollbackOrchestrationError) {
    return error.reason === "not-eligible" || error.reason === "drift" ? error.reason : "unexpected-state";
  }
  if (error instanceof RollbackSessionError) {
    if (error.reason === "lease-lost" || error.reason === "quiescence-unsatisfied") return error.reason;
    // A fence held by another generation is a refusal; a failed release is not a statement about eligibility.
    return error.reason === "lease-unavailable" ? "not-eligible" : "unexpected-state";
  }
  if (error instanceof RollbackInputResolutionError) return "input-unresolvable";
  if (
    error instanceof MigrationBindingUnresolvableError
    || (error instanceof BackendPublicationJournalError
      && (error.reason === "unresolved-publication" || error.reason === "publication-evidence-missing"))
  ) {
    return "unresolvable";
  }
  return "unexpected-state";
}

/** Maps any failure of a production rollback onto the closed error. */
export function toMigrationRollbackError(error: unknown): MigrationRollbackError {
  if (error instanceof MigrationRollbackError) return error;
  return new MigrationRollbackError(
    rollbackErrorReason(error),
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}

export interface RollbackEntryDependencies {
  context: ResolveRollbackContextDependencies;
  session: RollbackSessionDependencies;
  createCoordinator: typeof createBackendPublicationCoordinator;
  run: typeof runMigrationRollback;
}

export const DEFAULT_ROLLBACK_ENTRY_DEPENDENCIES: RollbackEntryDependencies = {
  context: DEFAULT_RESOLVE_ROLLBACK_CONTEXT_DEPENDENCIES,
  session: DEFAULT_ROLLBACK_SESSION_DEPENDENCIES,
  createCoordinator: createBackendPublicationCoordinator,
  run: runMigrationRollback,
};

/**
 * Rolls a migrated generation back to SQLite, from durable state alone.
 *
 * Resolves every input (manifest, preserved-source snapshot evidence, project
 * map, configuration, machine identity), opens one PostgreSQL runtime and
 * builds the real coordinator over its publication guard, so the lease the
 * fenced session takes and the one the coordinator adopts are the same row;
 * the fenced session shares that runtime, which this entry alone closes.
 * Re-running the same call is the recovery for every interrupted state. It is
 * deliberately not reachable from bin/ or src/cli/ in this change.
 */
export async function runMigrationRollbackFromHome(
  request: Readonly<{ homeDir: string; generationId: string; scratchParent?: string; signal?: AbortSignal }>,
  dependencies: RollbackEntryDependencies = DEFAULT_ROLLBACK_ENTRY_DEPENDENCIES,
): Promise<RunMigrationRollbackOutcome> {
  try {
    const context = await resolveMigrationRollbackContext(
      { homeDir: request.homeDir, generationId: request.generationId },
      dependencies.context,
    );
    const runtime = dependencies.session.createRuntime(context.target.settings);
    try {
      const coordinator = dependencies.createCoordinator({
        homeDir: request.homeDir,
        remoteGuard: {
          mode: "delegated",
          provider: createPostgreSqlBackendPublicationRemoteGuard({
            guard: runtime.backendPublicationGuard(),
            machineId: context.target.machineId,
            ttlMs: ROLLBACK_LEASE_TTL_MS,
          }),
        },
      });
      // The session closes its runtime when it is released, which can precede the coordinator's last use
      // (and a resume opens no session at all): the entry owns the runtime and closes it once.
      const shared: RollbackSessionRuntime = Object.assign(Object.create(runtime) as RollbackSessionRuntime, {
        close: async (): Promise<void> => undefined,
      });
      return await dependencies.run(
        { ...context.input, scratchParent: request.scratchParent, signal: request.signal },
        createMigrationRollbackDependencies({
          coordinator,
          target: context.target,
          sessionDependencies: { ...dependencies.session, createRuntime: () => shared },
        }),
      );
    } finally {
      await runtime.close();
    }
  } catch (error) {
    throw toMigrationRollbackError(error);
  }
}
