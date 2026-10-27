import { tmpdir } from "node:os";
import { canonicalJson, PORTABLE_RECORD_DOMAIN_ORDER, PORTABLE_RECORD_SCHEMA_SHA256 } from "../storage/portable-record.js";
import {
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  withBackendPublicationRetainedAppendAdmissionAsync,
  type BackendPublicationLockToken,
} from "../storage/backend-publication.js";
import { createPortableRecordStream, type PortableRecordStream } from "../storage/portable-record-stream.js";
import type { StorageIdentityContext } from "../storage/contracts.js";
import type { PostgreSqlConnectionSettings, PostgreSqlQueryExecutor } from "../storage/postgresql/contracts.js";
import { createPostgreSqlPortableSource, readPostgreSqlPortableSourceDomainCensus } from "../storage/postgresql/portable-source.js";
import { PostgreSqlRuntime } from "../storage/postgresql/runtime.js";
import { verifyPostgreSqlRuntimeSchema } from "../storage/postgresql/runtime-readiness.js";
import {
  POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_KEY,
  POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_TYPE,
} from "../storage/postgresql/publication-guard.js";
import type { PostgreSqlSnapshotSession } from "../storage/postgresql/snapshot-session.js";
import {
  acquireActivationLease,
  assertActivationLeaseFence,
  releaseActivationLease,
  renewActivationLease,
  resolveActivationLeaseFence,
  takeoverActivationLease,
  type ActivationLeaseFence,
  type ActivationLeasePublicationGuard,
} from "./activation-lease.js";
import { checkActivationWriterQuiescence, checkCutoverSetActivationWriterQuiescence } from "./activation-quiescence.js";
import {
  createMigrationActivationWitness,
  createMigrationQuiescenceFence,
  migrationCanonicalDeltaChanged,
  type MigrationSelectionAuthority,
} from "./activation-witness.js";
import { deriveRollbackProjectEvidenceSha256, deriveRollbackPublicationId } from "./rollback.js";
import type {
  ComputeRollbackTerminalEvidenceInput,
  OpenRollbackFencedSession,
  RollbackExportSource,
  RollbackFencedSession,
} from "./rollback.js";
import type { RollbackEligibilityObservation } from "./rollback-eligibility.js";
import {
  assertPermanentReadOnlyGuard,
  buildMigrationCanonicalDelta,
  buildMigrationCensusVector,
  captureDestinationIdentity,
  captureDestinationSchemaWitness,
  readFencedDestinationCensus,
} from "./verify-generation.js";

/**
 * The production fenced PostgreSQL session of a rollback (Boundary F,
 * plan-v3 section 4), composed from the modules main already has: the
 * publication lease (activation-lease.ts), writer quiescence
 * (activation-quiescence.ts), the verification driver's destination
 * captures and fenced census, and the PostgreSQL portable source. Nothing
 * here derives a new digest.
 *
 * Fence. One lease on the covered project's backend-publication row, with
 * exactly the identity the coordinator will adopt for the rollback
 * publication (plan-v3.1 amendment A7, seam section 19): the project's
 * remote id, this machine's id, the rollback publicationId, target backend
 * "sqlite", and rollback-project evidence derived by
 * {@link deriveRollbackProjectEvidenceSha256}. renew() renews and then
 * asserts the same identity; anything but a satisfied assertion throws. An
 * expired lease refuses: there is no silent token rotation under an open
 * snapshot.
 *
 * Admission. Rollback runs after activation, under the runtime role the
 * activated configuration names, so the schema is admitted with the runtime
 * privilege profile (not the transfer profile the copy and verification
 * drivers use).
 *
 * Snapshots. Every readback opens its own read-only snapshot, so steps 4
 * and 10 never share one. Each captures the destination identity and the
 * schema witness (which refuses a destination outside the pinned schema
 * contract), then reads the census ONCE and derives both the canonical delta
 * and the census vector from that one result (amendment A11). The export
 * source reads inside its own snapshot and reports the same two values
 * for that snapshot, so step 10 can compare them (amendment A6).
 *
 * Release. Before the coordinator has acquired the lease the session
 * releases it, first taking over its own expired lease (seam section 19).
 * After the coordinator has acquired it the session never releases and
 * only verifies the row is present and released
 * ({@link RollbackProductionSession.markCoordinatorAcquired}). Failures
 * surface; the runtime is closed either way.
 */

/** How long one acquisition or renewal keeps the lease. Fixed, not caller-supplied. */
export const ROLLBACK_LEASE_TTL_MS = 15 * 60 * 1000;
/**
 * How often a fenced read in flight (the census scan, the export) renews the lease: a third of the TTL, so a
 * renewal may run late twice before the lease could lapse. A renewal that fails aborts the read fail-closed.
 */
export const ROLLBACK_LEASE_RENEWAL_INTERVAL_MS = ROLLBACK_LEASE_TTL_MS / 3;

export type RollbackSessionErrorReason =
  | "lease-unavailable"
  | "lease-lost"
  | "quiescence-unsatisfied"
  | "release-failed";

export class RollbackSessionError extends Error {
  constructor(readonly reason: RollbackSessionErrorReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RollbackSessionError";
  }
}

/** The covered project and the PostgreSQL target a rollback runs against. */
export type RollbackSessionTarget = Readonly<{
  settings: PostgreSqlConnectionSettings;
  expectedOwner: string;
  /** id and remoteProjectId are the PostgreSQL project id; selectedPath is the project's canonical path. */
  expectedIdentity: StorageIdentityContext;
  localProjectId: string;
  remoteProjectId: string;
  machineId: string;
}>;

export { deriveRollbackProjectEvidenceSha256 };

export interface RollbackSessionRuntime extends PostgreSqlQueryExecutor {
  backendPublicationGuard(): ActivationLeasePublicationGuard;
  openReadOnlySnapshot(options: { projectId: string; signal?: AbortSignal }): Promise<PostgreSqlSnapshotSession>;
  close(): Promise<void>;
}

export interface RollbackSessionDependencies {
  createRuntime(settings: PostgreSqlConnectionSettings): RollbackSessionRuntime;
  verifyRuntimeSchema: typeof verifyPostgreSqlRuntimeSchema;
  assertReadOnlyGuard: typeof assertPermanentReadOnlyGuard;
  captureDestinationIdentity: typeof captureDestinationIdentity;
  captureDestinationSchemaWitness: typeof captureDestinationSchemaWitness;
  readFencedDestinationCensus: typeof readFencedDestinationCensus;
  createPortableSource: typeof createPostgreSqlPortableSource;
  readDomainCensus: typeof readPostgreSqlPortableSourceDomainCensus;
  createStream: typeof createPortableRecordStream;
  checkQuiescence: typeof checkActivationWriterQuiescence;
  checkRecoveryAdmission: typeof checkRollbackRecoveryAdmission;
  /** Set-member quiescence under the rollback hold (#1550 D4); the set-aware activation check when omitted. */
  checkSetQuiescence?: typeof checkCutoverSetActivationWriterQuiescence;
  /** Set recovery admission (#1550 D4); {@link checkCutoverSetRollbackRecoveryAdmission} when omitted. */
  checkSetRecoveryAdmission?: typeof checkCutoverSetRollbackRecoveryAdmission;
  /** Renewal cadence of a fenced read in flight; defaults to {@link ROLLBACK_LEASE_RENEWAL_INTERVAL_MS}. */
  renewalIntervalMs?: number;
}

export const DEFAULT_ROLLBACK_SESSION_DEPENDENCIES: RollbackSessionDependencies = {
  createRuntime: (settings) => new PostgreSqlRuntime(settings),
  verifyRuntimeSchema: verifyPostgreSqlRuntimeSchema,
  assertReadOnlyGuard: assertPermanentReadOnlyGuard,
  captureDestinationIdentity,
  captureDestinationSchemaWitness,
  readFencedDestinationCensus,
  createPortableSource: createPostgreSqlPortableSource,
  readDomainCensus: readPostgreSqlPortableSourceDomainCensus,
  createStream: createPortableRecordStream,
  checkQuiescence: checkActivationWriterQuiescence,
  checkRecoveryAdmission: checkRollbackRecoveryAdmission,
  renewalIntervalMs: ROLLBACK_LEASE_RENEWAL_INTERVAL_MS,
};

/** The session a rollback receives, plus the one hook the coordinator wiring (S4) needs. */
export interface RollbackProductionSession extends RollbackFencedSession {
  /**
   * Call once the coordinator has acquired the lease for the rollback
   * publication. From then on release() only verifies that the row is
   * present and released; it never releases it itself.
   */
  markCoordinatorAcquired(): void;
}

type LeaseTuple = Readonly<{
  projectId: string;
  machineId: string;
  publicationId: string;
  targetBackend: "sqlite";
  evidenceSha256: string;
}>;

async function acquireRollbackLease(
  guard: ActivationLeasePublicationGuard,
  tuple: LeaseTuple,
  signal: AbortSignal | undefined,
): Promise<ActivationLeaseFence> {
  const acquired = await acquireActivationLease(guard, { ...tuple, ttlMs: ROLLBACK_LEASE_TTL_MS, signal });
  if (acquired.status === "acquired") return acquired.fence;
  if (acquired.status !== "expired-needs-takeover") {
    throw new RollbackSessionError("lease-unavailable", acquired.detail);
  }
  // A crashed earlier attempt of this same rollback left its lease expired and unreleased: the
  // same generation may take it over, compare-and-swap on the token it read.
  const stored = await resolveActivationLeaseFence(guard, { ...tuple, signal });
  if (stored.kind !== "present") {
    throw new RollbackSessionError("lease-unavailable", "the expired lease could not be read back for takeover");
  }
  const took = await takeoverActivationLease(guard, {
    ...tuple, ttlMs: ROLLBACK_LEASE_TTL_MS, expectedFencingToken: stored.fence.fencingToken, signal,
  });
  if (took.status !== "took-over") throw new RollbackSessionError("lease-unavailable", took.detail);
  return took.fence;
}

/**
 * Keeps the lease renewed while a long fenced read is in flight. Its signal aborts the read when a renewal
 * fails (or when the session's own signal aborts); stop() reports that failure, so no read that outlived its
 * fence is ever consumed as fenced.
 */
type LeaseRenewalKeeper = Readonly<{
  signal: AbortSignal;
  /** Throws the renewal failure, if one was recorded. */
  assertFenced(): void;
  /** Stops renewing, waits for a renewal in flight, then throws the renewal failure if one was recorded. */
  stop(): Promise<void>;
}>;

/**
 * Lifetime ownership of a session (#1550 C8). A single-generation session
 * owns its runtime and runs its own renewal keeper across every long read
 * (the defaults). A set member session receives the set service's shared
 * runtime, which it never closes, and defers renewal to the service's one
 * set-wide keeper: its own periodic keeper is suppressed so two renewals
 * never run against the same lease, while the keeper's signal (passed as
 * the session's signal) still aborts a read in flight when a renewal fails.
 */
type SessionLifetime = Readonly<{ ownsRuntime: boolean; suppressKeeper: boolean }>;
const OWNING_LIFETIME: SessionLifetime = { ownsRuntime: true, suppressKeeper: false };

class FencedRollbackSession implements RollbackProductionSession {
  readonly selectionAuthority: MigrationSelectionAuthority;
  /** Sealed once quiescence is observed, before the session is handed out. */
  quiescenceFenceEvidenceSha256 = "";
  private fence: ActivationLeaseFence;
  private coordinatorAcquired = false;
  private released = false;
  private readonly snapshots = new Set<PostgreSqlSnapshotSession>();
  /** Renewal keepers of reads still in flight (an export whose stream was never closed); release stops them. */
  private readonly keepers = new Set<LeaseRenewalKeeper>();

  constructor(
    private readonly runtime: RollbackSessionRuntime,
    private readonly guard: ActivationLeasePublicationGuard,
    private readonly tuple: LeaseTuple,
    fence: ActivationLeaseFence,
    private readonly target: RollbackSessionTarget,
    private readonly scratchParent: string,
    private readonly signal: AbortSignal | undefined,
    private readonly dependencies: RollbackSessionDependencies,
    private readonly lifetime: SessionLifetime = OWNING_LIFETIME,
  ) {
    this.fence = fence;
    // Field for field the lease row the fence acquired: its resource coordinates, its token, and
    // owner_process_id, which the guard stores as the publicationId.
    this.selectionAuthority = {
      version: 1,
      resourceType: POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_TYPE,
      resourceKey: POSTGRESQL_BACKEND_PUBLICATION_RESOURCE_KEY,
      fencingToken: fence.fencingToken.toString(),
      ownerProcessId: fence.publicationId,
    };
  }

  markCoordinatorAcquired(): void {
    this.coordinatorAcquired = true;
  }

  /** The lease fence this session currently holds (its token advances on renewal). */
  get currentFence(): ActivationLeaseFence {
    return this.fence;
  }

  async renew(): Promise<void> {
    const renewed = await renewActivationLease(this.guard, {
      ...this.tuple, fencingToken: this.fence.fencingToken, ttlMs: ROLLBACK_LEASE_TTL_MS, signal: this.signal,
    });
    if (renewed.status !== "renewed") throw new RollbackSessionError("lease-lost", renewed.detail);
    this.fence = renewed.fence;
    const asserted = await assertActivationLeaseFence(this.guard, { ...this.tuple, signal: this.signal });
    if (asserted.status !== "satisfied") throw new RollbackSessionError("lease-lost", asserted.detail);
  }

  /**
   * The census scan and the export can outlast the lease TTL on a large destination; the fence must be
   * renewed across them, from a timer the read's own exit paths clear, with any renewal failure aborting the
   * read rather than letting it finish unfenced. Renewals never overlap (a renewal still waiting on the pool,
   * is awaited at stop, never duplicated). A renewal needs a pool connection of its own while the read holds
   * one: with a single-connection pool it would only wait for the read to end (and time out under the pool's
   * connection timeout, failing a read that is still fenced), so the keeper is inert there and such a
   * destination must finish each read within the lease TTL, as documented.
   */
  private startRenewalKeeper(): LeaseRenewalKeeper {
    const controller = new AbortController();
    const external = this.signal;
    const onExternalAbort = (): void => controller.abort(external?.reason);
    if (external?.aborted) controller.abort(external.reason);
    else external?.addEventListener("abort", onExternalAbort, { once: true });
    if (this.target.settings.poolMax <= 1 || this.lifetime.suppressKeeper) {
      // Inert (no periodic renewal), but owned like an active keeper: session cleanup of an export whose stream
      // was never closed must still detach the caller-signal listener (E11). A set member session is inert by
      // construction: the set service's one keeper renews every member's lease (#1550 C8).
      const inert: LeaseRenewalKeeper = {
        signal: controller.signal,
        assertFenced: () => undefined,
        stop: async () => {
          this.keepers.delete(inert);
          external?.removeEventListener("abort", onExternalAbort);
        },
      };
      this.keepers.add(inert);
      return inert;
    }
    let failure: unknown;
    let pending: Promise<void> | null = null;
    const timer = setInterval(() => {
      if (pending !== null || failure !== undefined) return;
      pending = this.renew().then(
        () => { pending = null; },
        (error: unknown) => {
          pending = null;
          failure = error;
          clearInterval(timer);
          controller.abort(error);
        },
      );
    }, this.dependencies.renewalIntervalMs ?? ROLLBACK_LEASE_RENEWAL_INTERVAL_MS);
    timer.unref?.();
    const keeper: LeaseRenewalKeeper = {
      signal: controller.signal,
      assertFenced: () => { if (failure !== undefined) throw failure; },
      stop: async () => {
        this.keepers.delete(keeper);
        clearInterval(timer);
        external?.removeEventListener("abort", onExternalAbort);
        if (pending !== null) await pending;
        if (failure !== undefined) throw failure;
      },
    };
    this.keepers.add(keeper);
    return keeper;
  }

  /** Runs a fenced read under a renewal keeper; a renewal failure is what is reported, before any read error. */
  private async withRenewal<T>(body: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const keeper = this.startRenewalKeeper();
    let result: T;
    try {
      result = await body(keeper.signal);
    } catch (error) {
      await keeper.stop();
      throw error;
    }
    await keeper.stop();
    return result;
  }

  private async admittedSnapshot(): Promise<PostgreSqlSnapshotSession> {
    const snapshot = await this.runtime.openReadOnlySnapshot({
      projectId: this.target.remoteProjectId, signal: this.signal,
    });
    this.snapshots.add(snapshot);
    try {
      await this.dependencies.assertReadOnlyGuard(snapshot, this.signal);
      await this.dependencies.verifyRuntimeSchema(snapshot, {
        expectedOwner: this.target.expectedOwner, signal: this.signal,
      });
    } catch (error) {
      await this.closeSnapshot(snapshot).catch(() => undefined);
      throw error;
    }
    return snapshot;
  }

  private async closeSnapshot(snapshot: PostgreSqlSnapshotSession): Promise<void> {
    this.snapshots.delete(snapshot);
    await snapshot.close();
  }

  async captureReadback(input: Parameters<RollbackFencedSession["captureReadback"]>[0]): Promise<RollbackEligibilityObservation> {
    // The census scan is renewed across its duration (a large destination can outlast the lease TTL).
    return this.withRenewal(async (signal) => {
      const snapshot = await this.admittedSnapshot();
      try {
        const destinationIdentity = await this.dependencies.captureDestinationIdentity(
          snapshot, this.target.remoteProjectId, signal,
        );
        // Refuses a destination outside the pinned schema contract, whose census would not be comparable.
        await this.dependencies.captureDestinationSchemaWitness(snapshot, signal);
        // ONE census scan: the delta and the vector both come from this result.
        const read = await this.dependencies.readFencedDestinationCensus(snapshot, {
          settings: this.target.settings,
          expectedOwner: this.target.expectedOwner,
          expectedIdentity: this.target.expectedIdentity,
          scratchParent: this.scratchParent,
          signal,
        });
        const postEpochDelta = buildMigrationCanonicalDelta(read.census);
        const deltaEqual = !migrationCanonicalDeltaChanged(postEpochDelta, input.canonicalDeltaBaseline);
        return {
          observedPortableRecordSchemaSha256: PORTABLE_RECORD_SCHEMA_SHA256,
          destinationIdentity,
          postEpochDelta,
          postEpochCensus: deltaEqual || input.requireCensus === true ? buildMigrationCensusVector(read.census) : null,
        };
      } finally {
        await this.closeSnapshot(snapshot);
      }
    });
  }

  async openPortableSource(): Promise<RollbackExportSource> {
    // The snapshot stays open for the whole export and is closed with the returned stream (the borrowed-session
    // source never closes it itself), so a one-connection pool is free again for the renewal and the fresh
    // readback that follow the transfer (F4). release() closes it if the stream was never closed.
    // The export is renewed across its duration too: the keeper runs until the stream is closed, every batch
    // read refuses once a renewal failed, and the close reports that failure.
    const keeper = this.startRenewalKeeper();
    let snapshot: PostgreSqlSnapshotSession;
    try {
      snapshot = await this.admittedSnapshot();
    } catch (error) {
      await keeper.stop();
      throw error;
    }
    try {
      const source = await this.dependencies.createPortableSource({
        settings: this.target.settings,
        expectedOwner: this.target.expectedOwner,
        expectedIdentity: this.target.expectedIdentity,
        scratchParent: this.scratchParent,
        signal: keeper.signal,
        session: snapshot,
      });
      try {
        const census = PORTABLE_RECORD_DOMAIN_ORDER.map((domain) => this.dependencies.readDomainCensus(source, domain));
        return {
          stream: this.closingSnapshotWith(await this.dependencies.createStream(source), snapshot, keeper),
          canonicalDelta: buildMigrationCanonicalDelta(census),
          censusVector: buildMigrationCensusVector(census),
        };
      } catch (error) {
        await source.close().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      await this.closeSnapshot(snapshot).catch(() => undefined);
      await keeper.stop();
      throw error;
    }
  }

  /**
   * The stream, whose close also closes the export snapshot it reads (once, whatever the stream's own close does)
   * and stops the lease renewal that spanned the export; a batch is handed out only while the lease is renewed.
   */
  private closingSnapshotWith(
    stream: PortableRecordStream,
    snapshot: PostgreSqlSnapshotSession,
    keeper: LeaseRenewalKeeper,
  ): PortableRecordStream {
    let closed = false;
    return {
      describe: () => stream.describe(),
      readBatch: async (input) => {
        keeper.assertFenced();
        const batch = await stream.readBatch(input);
        keeper.assertFenced();
        return batch;
      },
      verify: (checkpoint) => stream.verify(checkpoint),
      close: async () => {
        if (closed) return;
        closed = true;
        let failure: unknown;
        try { await stream.close(); } catch (error) { failure = error; }
        try { await this.closeSnapshot(snapshot); } catch (error) { failure ??= error; }
        try { await keeper.stop(); } catch (error) { failure = error; }
        if (failure !== undefined) throw failure;
      },
    };
  }

  computeRollbackTerminalEvidenceSha256(input: ComputeRollbackTerminalEvidenceInput): string {
    return createMigrationActivationWitness({
      kind: "rollback",
      epoch: input.epoch,
      attempt: input.attempt,
      postEpochDelta: input.observation.postEpochDelta,
      postEpochCensus: input.observation.postEpochCensus,
      rollbackMode: input.mode,
    }).checksumSha256;
  }

  private async releaseLease(): Promise<void> {
    const request = { ...this.tuple, fencingToken: this.fence.fencingToken, signal: this.signal };
    const released = await releaseActivationLease(this.guard, request);
    if (released.status === "released" || released.status === "already-released") return;
    if (released.status !== "expired") throw new RollbackSessionError("release-failed", released.detail);
    // Expiry is not release: take over our own expired lease, then release the fresh fence.
    const took = await takeoverActivationLease(this.guard, {
      ...this.tuple, ttlMs: ROLLBACK_LEASE_TTL_MS, expectedFencingToken: released.fence.fencingToken, signal: this.signal,
    });
    if (took.status !== "took-over") throw new RollbackSessionError("release-failed", took.detail);
    const again = await releaseActivationLease(this.guard, { ...request, fencingToken: took.fence.fencingToken });
    if (again.status !== "released" && again.status !== "already-released") {
      throw new RollbackSessionError("release-failed", again.detail);
    }
  }

  private async verifyReleased(): Promise<void> {
    const stored = await resolveActivationLeaseFence(this.guard, { ...this.tuple, signal: this.signal });
    if (stored.kind !== "present" || stored.fence.releasedAt === null) {
      throw new RollbackSessionError(
        "release-failed",
        "the coordinator was expected to have released the rollback lease, but it is not recorded as released",
      );
    }
  }

  /**
   * Closes the owned resources (snapshots, runtime) and leaves the lease exactly as it is: held until it expires
   * or the same rollback takes it over. Used from the moment the maintenance selection was attempted, because a
   * released lease admits guarded PostgreSQL writers while a selection is pending (plan-v3.2 A-01 / F1).
   */
  async closeKeepingLease(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const failures: unknown[] = [];
    for (const keeper of [...this.keepers]) {
      try { await keeper.stop(); } catch (error) { failures.push(error); }
    }
    for (const snapshot of [...this.snapshots]) {
      try { await this.closeSnapshot(snapshot); } catch (error) { failures.push(error); }
    }
    if (this.lifetime.ownsRuntime) {
      try { await this.runtime.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw failures[0];
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const failures: unknown[] = [];
    const attempt = async (step: () => Promise<void>): Promise<void> => {
      try { await step(); } catch (error) { failures.push(error); }
    };
    for (const keeper of [...this.keepers]) await attempt(() => keeper.stop());
    for (const snapshot of [...this.snapshots]) await attempt(() => this.closeSnapshot(snapshot));
    await attempt(() => (this.coordinatorAcquired ? this.verifyReleased() : this.releaseLease()));
    if (this.lifetime.ownsRuntime) await attempt(() => this.runtime.close());
    if (failures.length > 0) throw failures[0];
  }
}

/** A set member session: the fenced session plus its current fence, for the service's set-wide renewal. */
export interface CutoverSetRollbackMemberSession extends RollbackProductionSession {
  readonly currentFence: ActivationLeaseFence;
}

export type OpenCutoverSetRollbackFencedSessionInput = Readonly<{
  homeDir: string;
  /** The retained append-barrier token of the rollback window. */
  lockToken: BackendPublicationLockToken;
  /** The ORIGINAL member generation whose binding view is fenced. */
  generationId: string;
  /** The rollback hold's set id, shared by every member's lease and by the reverse publication. */
  publicationId: string;
  /** The set service's one runtime; the session never closes it. */
  runtime: RollbackSessionRuntime;
  scratchParent?: string;
  signal?: AbortSignal;
  /** Admit this rollback's own later journal phases and keep the lease on failure (as the single-generation recovery open). */
  recovery?: true;
}>;

/**
 * Open one member's fenced session under a set rollback hold (#1550 D4,
 * C8): the same lease tuple the reverse coordinator adopts for that member
 * (its remote project, this machine, the rollback set id as publication,
 * target sqlite, the member's rollback project evidence derived from its
 * ORIGINAL generation and the shared publication), then the set-aware
 * member quiescence under the retained token, or the set recovery admission
 * for a resumed hold. The runtime is the service's and is never closed here;
 * the session's own renewal keeper is suppressed in favor of the service's
 * set keeper. A failure after the lease was acquired releases it (best
 * effort) unless this is a recovery open, which keeps it.
 * openRollbackFencedSession's defaults and outputs are unchanged.
 */
export async function openCutoverSetRollbackFencedSession(
  input: OpenCutoverSetRollbackFencedSessionInput,
  target: RollbackSessionTarget,
  dependencies: RollbackSessionDependencies = DEFAULT_ROLLBACK_SESSION_DEPENDENCIES,
): Promise<CutoverSetRollbackMemberSession> {
  const tuple: LeaseTuple = {
    projectId: target.remoteProjectId,
    machineId: target.machineId,
    publicationId: input.publicationId,
    targetBackend: "sqlite",
    evidenceSha256: deriveRollbackProjectEvidenceSha256({
      generationId: input.generationId,
      publicationId: input.publicationId,
      localProjectId: target.localProjectId,
      remoteProjectId: target.remoteProjectId,
    }),
  };
  const guard = input.runtime.backendPublicationGuard();
  const fence = await acquireRollbackLease(guard, tuple, input.signal);
  const session = new FencedRollbackSession(
    input.runtime, guard, tuple, fence, target, input.scratchParent ?? tmpdir(), input.signal, dependencies,
    { ownsRuntime: false, suppressKeeper: true },
  );
  try {
    const quiescence = input.recovery === true
      ? await (dependencies.checkSetRecoveryAdmission ?? checkCutoverSetRollbackRecoveryAdmission)({
        homeDir: input.homeDir, lockToken: input.lockToken, setId: input.publicationId,
        generationId: input.generationId, machineId: target.machineId,
      })
      : await (dependencies.checkSetQuiescence ?? checkCutoverSetActivationWriterQuiescence)({
        homeDir: input.homeDir, lockToken: input.lockToken, generationId: input.generationId,
      });
    if (quiescence.status !== "satisfied") {
      throw new RollbackSessionError("quiescence-unsatisfied", quiescence.detail);
    }
    const sealed = createMigrationQuiescenceFence({
      kind: quiescence.quiescenceFence!.kind, payload: quiescence.quiescenceFence!.payload,
    });
    session.quiescenceFenceEvidenceSha256 = sealed.evidenceSha256;
    return session;
  } catch (error) {
    await (input.recovery === true ? session.closeKeepingLease() : session.release()).catch(() => undefined);
    throw error;
  }
}

const SET_RECOVERY_ADMISSION_KIND = "lcm-cutover-set-rollback-recovery-admission-v1";

/**
 * Admission of a set member's recovery session (#1550 D4). A set rollback's
 * first open asserts the set-aware member quiescence under the freshly held
 * rollback hold. A recovery runs after the rollback attempted its one
 * selection, so the journal is in a later phase. This check accepts exactly
 * the journals the set rollback itself leaves behind, under the same retained
 * local append barrier, and nothing else:
 *
 * - the rollback hold (a cutover-set maintenance journal whose set and
 *   publication id are the rollback set id) targeting sqlite, at
 *   selection-prepared or selection-completed, whose manifest names the
 *   member and whose member roster is this machine alone; or
 * - no maintenance journal and a non-terminal publication journal with the
 *   rollback set id (the coordinator archived the hold when it prepared the
 *   reverse publication), including one the coordinator aborted; the set
 *   rollback proves the composition, the restored source and the frozen
 *   evidence itself before it composes the publication again.
 */
export async function checkCutoverSetRollbackRecoveryAdmission(input: Readonly<{
  homeDir: string;
  lockToken: BackendPublicationLockToken;
  setId: string;
  generationId: string;
  machineId: string;
}>): Promise<RollbackRecoveryAdmissionResult> {
  return withBackendPublicationRetainedAppendAdmissionAsync(input.homeDir, (): RollbackRecoveryAdmissionResult => {
    const refuse = (detail: string): RollbackRecoveryAdmissionResult => ({ status: "unsatisfied", detail, quiescenceFence: null });
    const admit = (journal: "maintenance" | "publication", phase: string, checksumSha256: string): RollbackRecoveryAdmissionResult => ({
      status: "satisfied",
      detail: "recovery of this set rollback's own " + journal + " journal at " + phase,
      quiescenceFence: {
        kind: SET_RECOVERY_ADMISSION_KIND,
        payload: canonicalJson({
          version: 1, journal, phase, checksumSha256, setId: input.setId, generationId: input.generationId, machineId: input.machineId,
        }),
      },
    });
    const maintenance = readBackendMaintenanceJournal(input.homeDir);
    if (maintenance !== null) {
      if (
        maintenance.cutoverSet === undefined
        || maintenance.generationId !== input.setId
        || maintenance.publicationId !== input.setId
        || maintenance.sourceBackend !== "postgresql"
        || maintenance.targetBackend !== "sqlite"
      ) {
        return refuse("the maintenance journal (phase " + maintenance.phase + ") is not this set rollback's attempted selection");
      }
      const index = maintenance.cutoverSet.manifest.members.findIndex((member) => member.generationId === input.generationId);
      if (index < 0) return refuse("the rollback hold does not name generation " + input.generationId);
      const roster = maintenance.cutoverSet.bindings[index]!.roster;
      if (roster.length !== 1 || roster[0]!.machineId !== input.machineId) {
        return refuse("the member's roster is not this machine alone");
      }
      return admit("maintenance", maintenance.phase, maintenance.checksumSha256);
    }
    const publication = readBackendPublicationJournal(input.homeDir);
    if (publication === null || publication.publicationId !== input.setId || publication.phase === "completed") {
      return refuse("no journal of this set rollback's attempted selection or in-flight publication remains");
    }
    return admit("publication", publication.phase, publication.checksumSha256);
  }, input.lockToken);
}

/**
 * Open the rollback's fenced session: lease, then quiescence under the
 * retained token. A failure after the lease was acquired releases it (best
 * effort; the original error is the one reported) and closes the runtime.
 * A recovery open (input.recovery) admits this rollback's own later journal
 * phases and, on failure, keeps the lease: its maintenance selection was
 * already attempted, so the lease is what still bars guarded writers.
 */
export async function openRollbackFencedSession(
  input: Parameters<OpenRollbackFencedSession>[0],
  target: RollbackSessionTarget,
  dependencies: RollbackSessionDependencies = DEFAULT_ROLLBACK_SESSION_DEPENDENCIES,
): Promise<RollbackProductionSession> {
  const publicationId = deriveRollbackPublicationId(input.manifest.generationId);
  const tuple: LeaseTuple = {
    projectId: target.remoteProjectId,
    machineId: target.machineId,
    publicationId,
    targetBackend: "sqlite",
    evidenceSha256: deriveRollbackProjectEvidenceSha256({
      generationId: input.manifest.generationId,
      publicationId,
      localProjectId: target.localProjectId,
      remoteProjectId: target.remoteProjectId,
    }),
  };
  const runtime = dependencies.createRuntime(target.settings);
  let session: FencedRollbackSession | undefined;
  try {
    await dependencies.verifyRuntimeSchema(runtime, { expectedOwner: target.expectedOwner, signal: input.signal });
    const guard = runtime.backendPublicationGuard();
    const fence = await acquireRollbackLease(guard, tuple, input.signal);
    // From here the lease exists: a failure must release it through the same path release() uses.
    const opened = new FencedRollbackSession(
      runtime, guard, tuple, fence, target, input.scratchParent ?? tmpdir(), input.signal, dependencies,
    );
    session = opened;
    const quiescence = input.recovery === true
      ? await dependencies.checkRecoveryAdmission({
        homeDir: input.homeDir, lockToken: input.lockToken, generationId: input.manifest.generationId,
        publicationId, machineId: target.machineId,
      })
      : await dependencies.checkQuiescence({ homeDir: input.homeDir, lockToken: input.lockToken });
    if (quiescence.status !== "satisfied") {
      throw new RollbackSessionError("quiescence-unsatisfied", quiescence.detail);
    }
    const sealed = createMigrationQuiescenceFence({
      kind: quiescence.quiescenceFence!.kind, payload: quiescence.quiescenceFence!.payload,
    });
    opened.quiescenceFenceEvidenceSha256 = sealed.evidenceSha256;
    return opened;
  } catch (error) {
    if (session === undefined) await runtime.close().catch(() => undefined);
    else if (input.recovery === true) await session.closeKeepingLease().catch(() => undefined);
    else await session.release().catch(() => undefined);
    throw error;
  }
}

const RECOVERY_ADMISSION_KIND = "lcm-rollback-recovery-admission-v1";

export type RollbackRecoveryAdmissionResult = Readonly<{
  status: "satisfied" | "unsatisfied";
  detail: string;
  quiescenceFence: Readonly<{ kind: string; payload: string }> | null;
}>;

/**
 * Admission of a recovery session (#626 F11). The first open of a rollback asserts quiescence under a freshly
 * held maintenance. A recovery runs after this rollback attempted its maintenance selection, so the journal is
 * in a later phase and checkActivationWriterQuiescence (maintenance-held only) can never be satisfied. This
 * check accepts exactly the journals this rollback itself leaves behind, under the same retained local append
 * barrier, and nothing else:
 *
 * - the maintenance journal of this generation and this rollback's publicationId, targeting sqlite, at
 *   selection-prepared or selection-completed, whose roster is this machine alone; or
 * - no maintenance journal (the coordinator archived it when it prepared the publication) and a non-terminal
 *   publication journal with this rollback's publicationId, or one the coordinator's missing-material exit took
 *   straight from preparing to aborted without ever sealing material (recoveryReference null): that publication
 *   recorded no fence and published nothing, and the rollback prepares it again (E6).
 * - an aborted publication of this rollback that had sealed its material (recoveryReference set): something else
 *   aborted it after it began. The abort restored the source and released what it recorded, and the rollback
 *   resumes it forward. This admission is not the proof of that: the rollback checks the journal's composition,
 *   the restored source and the authority itself before it composes the publication again (#1555).
 *
 * Every other journal, including a freshly held maintenance (which has the strict first-open path), is refused.
 * The lease tuple (project, machine, publicationId, target, evidence) is matched by the lease acquisition that
 * precedes this check (openRollbackFencedSession acquires first and keeps the lease if the check refuses). The
 * check proves no more about local writers than the retained barrier does; the guarded PostgreSQL
 * writers are barred by the lease row itself (acquirePostgreSqlProjectMutationGuard refuses while an unreleased
 * lease exists).
 */
export async function checkRollbackRecoveryAdmission(input: Readonly<{
  homeDir: string;
  lockToken: BackendPublicationLockToken;
  generationId: string;
  publicationId: string;
  machineId: string;
}>): Promise<RollbackRecoveryAdmissionResult> {
  return withBackendPublicationRetainedAppendAdmissionAsync(input.homeDir, (): RollbackRecoveryAdmissionResult => {
    const refuse = (detail: string): RollbackRecoveryAdmissionResult => ({ status: "unsatisfied", detail, quiescenceFence: null });
    const admit = (journal: "maintenance" | "publication", phase: string, checksumSha256: string): RollbackRecoveryAdmissionResult => ({
      status: "satisfied",
      detail: "recovery of this rollback's own " + journal + " journal at " + phase,
      quiescenceFence: {
        kind: RECOVERY_ADMISSION_KIND,
        payload: canonicalJson({
          version: 1, journal, phase, checksumSha256, generationId: input.generationId,
          publicationId: input.publicationId, machineId: input.machineId,
        }),
      },
    });
    const maintenance = readBackendMaintenanceJournal(input.homeDir);
    if (maintenance !== null) {
      if (
        maintenance.generationId !== input.generationId
        || maintenance.publicationId !== input.publicationId
        // The journal reader accepts a target backend only at selection-prepared or selection-completed (a held,
        // entering or aborted maintenance must carry none: backend-publication.ts, readMaintenanceJournal), so a
        // sqlite target already means one of the two phases this recovery admits.
        || maintenance.targetBackend !== "sqlite"
      ) {
        return refuse("the maintenance journal (phase " + maintenance.phase + ") is not this rollback's attempted selection");
      }
      if (maintenance.roster.length !== 1 || maintenance.roster[0]!.machineId !== input.machineId) {
        return refuse("the maintenance roster is not this machine alone");
      }
      return admit("maintenance", maintenance.phase, maintenance.checksumSha256);
    }
    const publication = readBackendPublicationJournal(input.homeDir);
    if (
      publication === null
      || publication.publicationId !== input.publicationId
      || publication.phase === "completed"
    ) {
      return refuse("no journal of this rollback's attempted selection or in-flight publication remains");
    }
    return admit("publication", publication.phase, publication.checksumSha256);
  }, input.lockToken);
}
