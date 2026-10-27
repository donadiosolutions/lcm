import { backendPublicationCanonicalSha256 } from "../storage/backend-publication.js";
import type { StorageIdentityContext } from "../storage/contracts.js";
import type { PostgreSqlConnectionSettings } from "../storage/postgresql/contracts.js";
import { classifySqliteSnapshotArtifact } from "./sqlite-snapshot.js";
import {
  inspectSqliteMigrationCopy,
  runSqliteMigrationCopy,
  type MigrationCopyTestingDependencies,
  type SqliteMigrationCopyInput,
} from "./batch-copy.js";
import { MigrationManifestStore } from "./manifest-store.js";
import {
  beginMigrationEffect,
  completeMigrationEffect,
  createMigrationManifest,
  MigrationProtocolError,
  type MigrationManifest,
} from "./protocol.js";

/**
 * Section 8's "held, matching | complete | absent | apply (genesis and
 * copy)" row: once a generation's snapshot is complete, apply mints its
 * manifest (if one does not already exist) and drives the copy to
 * completion, reusing #623's own `inspectSqliteMigrationCopy` /
 * `runSqliteMigrationCopy` rather than reimplementing any part of the
 * transfer (section 1).
 *
 * **Section 4.7, enforced in code, not only in the module doc.** Genesis
 * never runs unless `classifySqliteSnapshotArtifact` independently
 * classifies the *carried* `generationId` as `complete`, checked
 * immediately before genesis on every call — including a call that finds
 * the manifest already present, so a caller cannot skip the check by
 * reaching this function twice. This is the invariant this item maintains
 * ("snapshot absent implies manifest absent"): the read that proves it holds
 * runs at the point of use, not once somewhere upstream and trusted.
 *
 * **Section 4.9 exposure 2, applied to a new consumer.** `maintenanceChecksumSha256`
 * is a required parameter, carried from whatever produced it (capture's own
 * compare-and-swap input), never re-derived here by reading the
 * maintenance journal. This function never calls
 * `readBackendMaintenanceJournal` at all: the maintenance-side freshness
 * guarantee it would otherwise duplicate already lives in
 * `openMigrationCopySource`'s own `reauthenticateHeld`, which compares
 * against the checksum embedded in the *captured artifact itself* — a
 * second, independent observation this function does not need to
 * duplicate to be correct, and must not duplicate by re-reading, which
 * would only add a second place the same re-read defect could reappear.
 */
export type MigrationApplyGenesisAndCopyInput = Readonly<{
  homeDir: string;
  generationId: string;
  /**
   * The compare-and-swap input carried from capture (section 4.9 exposure
   * 2): apply's own observed `maintenanceChecksumSha256` at the point
   * capture completed. Bound into the dry-run effect's `inputSha256` so a
   * caller that reached genesis from a different maintenance state mints a
   * distinguishable effect rather than silently reusing one, without this
   * function itself re-reading the journal to compare it against anything.
   */
  maintenanceChecksumSha256: string;
  settings: PostgreSqlConnectionSettings;
  expectedOwner: string;
  expectedIdentity: StorageIdentityContext;
  ownerProcessId: string;
  maxRecords: number;
  maxBytes: number;
  leaseTtlMs?: number;
  maximumTransactionAttempts?: number;
  signal?: AbortSignal;
  manifestStore?: MigrationManifestStore;
  now?: Date;
  /**
   * Forwarded verbatim to `runSqliteMigrationCopy`'s own second parameter.
   * The identical seam already used at the batch-copy layer for
   * deterministic interruption in tests, threaded one layer up rather than
   * invented anew. Never consulted by production callers; an omitted value
   * behaves exactly as it always has, since `runSqliteMigrationCopy`
   * defaults this parameter to `{}` when passed `undefined`.
   */
  testing?: MigrationCopyTestingDependencies;
}>;

export type MigrationApplyGenesisAndCopyOutcome =
  | Readonly<{ status: "copied"; result: Awaited<ReturnType<typeof runSqliteMigrationCopy>> }>
  | Readonly<{ status: "refuse"; reason: string; evidence?: string }>;

function protocolEvidence(error: unknown): string {
  return error instanceof MigrationProtocolError ? `manifest-${error.reason}` : "manifest-internal-error";
}

function copyInputFrom(input: MigrationApplyGenesisAndCopyInput): SqliteMigrationCopyInput {
  return {
    generationId: input.generationId,
    homeDir: input.homeDir,
    settings: input.settings,
    expectedOwner: input.expectedOwner,
    expectedIdentity: input.expectedIdentity,
    ownerProcessId: input.ownerProcessId,
    maxRecords: input.maxRecords,
    maxBytes: input.maxBytes,
    ...(input.leaseTtlMs === undefined ? {} : { leaseTtlMs: input.leaseTtlMs }),
    ...(input.maximumTransactionAttempts === undefined ? {} : { maximumTransactionAttempts: input.maximumTransactionAttempts }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

/**
 * Genesis, run only when no manifest exists yet for this generation: probe
 * the real copy destination (`inspectSqliteMigrationCopy`, which is where
 * the destination witness genuinely comes from asking PostgreSQL what is
 * there — never fabricated locally), create the manifest from that witness
 * with no re-derivation of `source`/`destination`, then complete the
 * `verify-dry-run` effect that `runSqliteMigrationCopy` requires before it
 * will drive a single batch.
 */
async function genesis(
  input: MigrationApplyGenesisAndCopyInput,
  store: MigrationManifestStore,
  copyInput: SqliteMigrationCopyInput,
  now: string,
): Promise<Readonly<{ status: "ready" }> | Readonly<{ status: "refuse"; reason: string; evidence?: string }>> {
  let witness: Awaited<ReturnType<typeof inspectSqliteMigrationCopy>>;
  try {
    witness = await inspectSqliteMigrationCopy({ ...copyInput, destinationCapturedAt: now });
  } catch (error) {
    return { status: "refuse", reason: "genesis-inspection-failed", evidence: error instanceof Error ? error.name : "unknown-inspection-failure" };
  }

  let journal: MigrationManifest;
  try {
    journal = store.create(createMigrationManifest({
      generationId: input.generationId,
      source: witness.source,
      destination: witness.destination,
      parentGenerationId: null,
      preservedSourceGenerationId: input.generationId,
      createdAt: now,
    }));
  } catch (error) {
    return { status: "refuse", reason: "genesis-create-failed", evidence: protocolEvidence(error) };
  }

  return dryRunEffect(input, store, journal, witness.bindingSha256, undefined);
}

/**
 * The begin-then-complete of the `verify-dry-run` effect, shared by genesis
 * and by performMigrationGenesisDryRun's two resume cells. With
 * `carriedEffectId` the effect is already pending (begun by an earlier
 * invocation), so it is only completed, with that exact id; a begin is
 * never repeated.
 */
function dryRunEffect(
  input: MigrationApplyGenesisAndCopyInput,
  store: MigrationManifestStore,
  manifest: MigrationManifest,
  bindingSha256: string,
  carriedEffectId: string | undefined,
): Readonly<{ status: "ready" }> | Readonly<{ status: "refuse"; reason: string; evidence?: string }> {
  let journal = manifest;
  const effectId = carriedEffectId ?? backendPublicationCanonicalSha256({
    kind: "migration-apply-dry-run-effect",
    generationId: input.generationId,
    maintenanceChecksumSha256: input.maintenanceChecksumSha256,
  });
  if (carriedEffectId === undefined) {
    const inputSha256 = backendPublicationCanonicalSha256({
      kind: "migration-apply-dry-run-input",
      maintenanceChecksumSha256: input.maintenanceChecksumSha256,
      bindingSha256,
    });
    try {
      const begun = beginMigrationEffect(journal, {
        kind: "verify-dry-run",
        effectId,
        inputSha256,
        startedAt: journal.updatedAt,
      });
      journal = store.update(input.generationId, journal.checksumSha256, () => begun);
    } catch (error) {
      return { status: "refuse", reason: "genesis-dry-run-begin-failed", evidence: protocolEvidence(error) };
    }
  }
  try {
    const completed = completeMigrationEffect(journal, {
      effectId,
      completedAt: journal.updatedAt,
      report: {
        kind: "dry-run",
        reportId: effectId,
        reportSha256: bindingSha256,
        createdAt: journal.updatedAt,
      },
    });
    store.update(input.generationId, journal.checksumSha256, () => completed);
  } catch (error) {
    return { status: "refuse", reason: "genesis-dry-run-complete-failed", evidence: protocolEvidence(error) };
  }
  return { status: "ready" };
}

export type MigrationGenesisDryRunInput = MigrationApplyGenesisAndCopyInput & Readonly<{
  /**
   * The effect id a router observed pending (plan-v5 row 20). Required when
   * a `verify-dry-run` effect is pending, and compared against the manifest
   * as it is now: a different id writes nothing.
   */
  carriedEffectId?: string;
}>;

export type MigrationGenesisDryRunOutcome =
  | Readonly<{ status: "ready" }>
  | Readonly<{ status: "refuse"; reason: string; evidence?: string }>;

/**
 * The genesis-and-dry-run half of apply, without the copy (plan-v5 Part A
 * item 6, rows 19-20). It is today's private `genesis()`, reachable on its
 * own, and returns before `runSqliteMigrationCopy`:
 *
 * - no manifest: inspect, create, begin and complete, exactly as apply does;
 * - manifest `planned`, nothing pending (a crash after create): begin and
 *   complete the dry-run effect;
 * - manifest `planned` with a pending `verify-dry-run` (a crash after
 *   begin): complete only the carried effect id.
 *
 * The destination is contacted in every case, because the pending effect
 * stores an input digest, not the dry-run report. A manifest that exists
 * binds the destination's capture time (`manifest.destination.capturedAt`),
 * never a fresh clock, so a re-inspection reproduces the sealed binding.
 * Capture-before-genesis (section 4.7) is enforced on every call.
 */
export async function performMigrationGenesisDryRun(
  input: MigrationGenesisDryRunInput,
): Promise<MigrationGenesisDryRunOutcome> {
  const snapshotRefusal = await refuseUnlessSnapshotComplete(input);
  if (snapshotRefusal !== null) return snapshotRefusal;

  const store = input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir });
  const copyInput = copyInputFrom(input);
  const presence = store.probeManifestPresence(input.generationId);
  if (presence.status === "unresolvable") {
    return { status: "refuse", reason: "manifest-unresolvable", evidence: `manifest-${presence.reason}` };
  }
  if (presence.status === "absent") {
    return genesis(input, store, copyInput, (input.now ?? new Date()).toISOString());
  }

  let manifest: MigrationManifest;
  try {
    manifest = store.read(input.generationId);
  } catch (error) {
    return { status: "refuse", reason: "manifest-unresolvable", evidence: protocolEvidence(error) };
  }
  const pending = manifest.pendingEffect;
  const resumable = manifest.phase === "planned"
    && (pending === null || pending.kind === "verify-dry-run");
  if (!resumable) {
    return { status: "refuse", reason: "genesis-dry-run-unexpected-state", evidence: `manifest-${manifest.phase}` };
  }
  if (pending !== null && pending.effectId !== input.carriedEffectId) {
    return { status: "refuse", reason: "genesis-dry-run-effect-mismatch" };
  }
  let witness: Awaited<ReturnType<typeof inspectSqliteMigrationCopy>>;
  try {
    witness = await inspectSqliteMigrationCopy({ ...copyInput, destinationCapturedAt: manifest.destination.capturedAt });
  } catch (error) {
    return { status: "refuse", reason: "genesis-inspection-failed", evidence: error instanceof Error ? error.name : "unknown-inspection-failure" };
  }
  return dryRunEffect(input, store, manifest, witness.bindingSha256, pending === null ? undefined : pending.effectId);
}

/** Section 4.7, enforced rather than documented: classified fresh, every call, before the manifest tree is consulted. */
async function refuseUnlessSnapshotComplete(
  input: MigrationApplyGenesisAndCopyInput,
): Promise<Readonly<{ status: "refuse"; reason: string; evidence?: string }> | null> {
  let snapshot: Awaited<ReturnType<typeof classifySqliteSnapshotArtifact>>;
  try {
    snapshot = await classifySqliteSnapshotArtifact(input.generationId, { homeDir: input.homeDir });
  } catch (error) {
    return { status: "refuse", reason: "snapshot-unresolvable", evidence: error instanceof Error ? error.name : "unknown-snapshot-failure" };
  }
  if (snapshot.state !== "complete") {
    return { status: "refuse", reason: "capture-incomplete", evidence: `snapshot-${snapshot.state}` };
  }
  return null;
}

export async function performMigrationApplyGenesisAndCopy(
  input: MigrationApplyGenesisAndCopyInput,
): Promise<MigrationApplyGenesisAndCopyOutcome> {
  // Section 4.7: capture-before-genesis, enforced here rather than only
  // documented -- the carried generationId is classified fresh, every call,
  // before anything below consults the manifest tree at all.
  const snapshotRefusal = await refuseUnlessSnapshotComplete(input);
  if (snapshotRefusal !== null) return snapshotRefusal;

  const store = input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir });
  const copyInput = copyInputFrom(input);

  const presence = store.probeManifestPresence(input.generationId);
  if (presence.status === "unresolvable") {
    return { status: "refuse", reason: "manifest-unresolvable", evidence: `manifest-${presence.reason}` };
  }
  if (presence.status === "absent") {
    const now = (input.now ?? new Date()).toISOString();
    const outcome = await genesis(input, store, copyInput, now);
    if (outcome.status === "refuse") return outcome;
  }
  // presence.status === "present": genesis already ran on an earlier
  // attempt (a crash between genesis and copy completion, or copy already
  // in progress or complete). Never re-created or re-derived here;
  // runSqliteMigrationCopy resumes from whatever phase and pendingEffect
  // are durable, which is exactly the property section 11's real-pipeline
  // interrupt-and-resume test exists to prove.

  let result: Awaited<ReturnType<typeof runSqliteMigrationCopy>>;
  try {
    result = await runSqliteMigrationCopy(copyInput, input.testing);
  } catch (error) {
    return { status: "refuse", reason: "copy-failed", evidence: error instanceof Error ? error.name : "unknown-copy-failure" };
  }
  return { status: "copied", result };
}
