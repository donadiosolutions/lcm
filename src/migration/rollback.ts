/**
 * Orchestration for item #626: rollback into a new SQLite generation.
 * Fencing, the journal and report lifecycle, publication, recovery and
 * abandonment, per plan-v2 section 5's twelve-step sequence (normative;
 * this file implements it and does not re-derive it) and
 * coordinator-seam-FROZEN.md v7.
 *
 * WHAT IS INJECTED, AND WHAT IT DEFAULTS TO. Every dependency below that has
 * a production implementation on this branch defaults to it, so a caller
 * (and a test) that supplies nothing exercises the real stores; each stays
 * overridable as a seam for failure injection:
 *
 *  - Boundary A: {@link MigrationWitnessResolver}, defaulting to
 *    generation-binding-store.ts's resolveMigrationWitnessBindings.
 *  - Activation evidence: {@link ActivationEvidenceResolver}, defaulting to
 *    activation-evidence-store.ts's readMigrationActivationEvidence. With A
 *    and Boundary C it feeds resolveActivationAuthority's three-observation
 *    truth table (plan-v3.1 amendment A1).
 *  - Boundary B has no seam: classifyMigrationRollbackMode is pure, and
 *    rollback-eligibility.ts adapts it directly.
 *  - Boundary C: {@link readBackendPublicationOperabilityFact}, below.
 *  - Boundaries D and D2: {@link MigrationSelectionBindingRecorder} and
 *    {@link MigrationWitnessBindingRecorder}, defaulting to
 *    recordMigrationSelectionBinding and recordMigrationWitnessBinding.
 *  - Boundary E: {@link RollbackAuthoritativeContextResolver}, defaulting
 *    to resolveRollbackAuthoritativeContext, which returns the full parsed
 *    epoch and attempt (and the selected witness) of the selection.
 *
 * STILL REQUIRED, NO DEFAULT:
 *
 *  - Boundary F: {@link OpenRollbackFencedSession}, the fenced PostgreSQL
 *    session (lease, quiescence, dedicated snapshot readback). The
 *    production one is rollback-session.ts's.
 *  - The BackendPublicationCoordinator, over the production driver and the
 *    PostgreSQL remote guard. rollback-inputs.ts's runMigrationRollbackFromHome
 *    builds it from the same runtime the session uses, so the lease the
 *    session holds is the one the coordinator adopts.
 *
 * ORDER (plan-v3.2 A16a, which supersedes plan-v3.1 A9's): the rollback
 * witness and its binding, begin publish-rollback, install (post-write),
 * the maintenance selection, the rollback selection binding, the
 * coordinator's publication of the sqlite config and project map, the
 * report, and the effect's
 * completion. The binding precedes the coordinator because its prepare()
 * archives the maintenance journal, after which replay admission routes
 * from bindings. Every crash row resumes by re-running the same call
 * (recoverPendingPublishRollback).
 *
 * * WHAT THIS FILE DOES OWN AND IMPLEMENT FOR REAL: the local fencing
 * sequence (enterMaintenance retention across the whole window), the
 * migration-protocol effect lifecycle (begin/complete/abandon via
 * MigrationManifestStore), calling rollback-generation.ts /
 * rollback-install.ts / rollback-sidecars.ts in the order plan-v2 section
 * 5 mandates, the maintenance-selection-to-report-persistence sequence,
 * crash recovery classification (step 1), and every deterministic-identity
 * derivation this item mints (inputSha256, publicationId, report
 * reportId), per section 8's convergence rule.
 */

import { createHash } from "node:crypto";
import { lstatSync, opendirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  atomicWritePrivateFileDurable,
  ensurePrivateDirectory,
  openPrivateDirectoryIfExists,
  syncPrivateDirectory,
  readBoundedRegularFileWithStat,
} from "../security-files.js";
import { parseDaemonConfig, resolveDaemonConfigEnv, type ResolvedStorageConfig } from "../daemon/config.js";
import { canonicalJson, canonicalSha256, sha256 } from "../storage/portable-record.js";
import { lcmHomeDir } from "../runtime-paths.js";
import type { PortableRecordStream } from "../storage/portable-record-stream.js";
import type { PortableProjectIdentity } from "../storage/portable-record-stream.js";
import {
  BackendPublicationJournalError,
  backendPublicationCanonicalSha256,
  backendPublicationDirectory,
  captureBackendPublicationFileWitness,
  captureBackendPublicationState,
  readAuthenticatedBackendPublicationMaterial,
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
  withBackendPublicationConsumerLock,
  withBackendPublicationConsumerLockAsync,
  withBackendPublicationAppendBarrierAsync,
  BackendPublicationCoordinator,
  type BackendPublicationJournal,
  type BackendPublicationFileWitness,
  type BackendPublicationLockToken,
  type BackendPublicationPhase,
  type BackendPublicationRecoveryFile,
  type BackendMaintenanceRosterEntry,
  type BackendMaintenanceJournal,
} from "../storage/backend-publication.js";
import {
  MigrationProtocolError,
  abandonMigrationEffect,
  beginMigrationEffect,
  classifyMigrationRecovery,
  completeMigrationEffect,
  type MigrationManifest,
  type MigrationReportReference,
} from "./protocol.js";
import { MigrationManifestStore } from "./manifest-store.js";
import { parseProjectMap, readProjectMapSnapshot, type ProjectMap } from "../project-map.js";
import type { StorageBackendName } from "../storage/contracts.js";
import {
  createMigrationActivationWitness,
  migrationCanonicalDeltaChanged,
  migrationCensusVectorsEqual,
  type MigrationActivationWitness,
  type MigrationActivationAttempt,
  type MigrationActivationEpoch,
  type MigrationCanonicalDelta,
  type MigrationCensusVector,
  type MigrationSelectionAuthority,
} from "./activation-witness.js";
import {
  readMigrationActivationEvidence,
  recordMigrationActivationWitness,
  resolveRollbackAuthoritativeContext,
} from "./activation-evidence-store.js";
import {
  composeBackendPublicationMaterial,
  readRetainedBackendPublicationMaterial,
} from "../storage/backend-publication-material.js";
import {
  MigrationBindingUnresolvableError,
  recordMigrationSelectionBinding,
  recordMigrationWitnessBinding,
  resolveMigrationWitnessBindings,
} from "./generation-binding-store.js";
import {
  evaluateRollbackEligibility,
  resolveActivationAuthority,
  type ActivationAuthority,
  type AuthoritativeActivation,
  type MigrationSelectionBinding,
  type MigrationWitnessBinding,
  type ActivationEvidenceResolver,
  type MigrationWitnessResolver,
  type OperabilityFactResolution,
  type RollbackAuthoritativeContext,
  type RollbackEligibilityDecision,
  type RollbackEligibilityObservation,
} from "./rollback-eligibility.js";
import { buildRollbackGeneration, type RollbackGenerationOutcome } from "./rollback-generation.js";
import { installRollbackGeneration } from "./rollback-install.js";
import { assertRollbackSidecarsCompatible, materializeRollbackSidecars } from "./rollback-sidecars.js";

const MAX_REPORT_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Boundary C. #626 owns this production implementation. See
// coordinator-seam-FROZEN.md v6 section 16: read the live
// BackendPublicationJournal (never delegate to
// assertBackendPublicationConsumerAccess or
// PostgreSqlStorageBackendFactory.capturePublicationWitness, both of which
// throw identically for "wrong backend" and "the read itself failed"),
// three-valued, and MUST be called during eligibility, strictly before
// this item's own enterMaintenance -- not merely before the coordinator's
// prepare() call. enterMaintenance archives the terminal journal out of
// the live slot exactly like prepare() does (both call
// archiveTerminalJournal on an existing terminal journal), so calling this
// reader after step 2 would observe an emptied slot on every single
// rollback attempt and never report "present", which is why
// runMigrationRollback below calls it before step 2, not between steps 2
// and 11 where section 16's prose alone might suggest.
// ---------------------------------------------------------------------------

function describeUnresolvable(error: unknown): string {
  if (error instanceof BackendPublicationJournalError) {
    return `${error.reason}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * donadiosolutions/lcm#1432. The exact, distinguishable reason
 * readBackendPublicationOperabilityFact reports when a maintenance
 * journal (terminal or not) holds the live slot -- the ONE unresolvable
 * cause that is expected and recoverable from the durable rollback-
 * authority artifact (see resolveRollbackOperabilityFact below). Named
 * here, as a single source of truth, so the two sites (the producer
 * below and the recovery fallback) cannot silently drift apart.
 */
const MAINTENANCE_HOLDS_LIVE_SLOT_REASON =
  "backend maintenance holds the live publication slot; no publication journal is readable";

export async function readBackendPublicationOperabilityFact(
  input: Readonly<{ homeDir?: string; lockToken?: BackendPublicationLockToken }>,
): Promise<OperabilityFactResolution> {
  try {
    return await withBackendPublicationConsumerLockAsync(
      input.homeDir,
      async () => {
        // The maintenance and publication journals share one live file
        // slot (coordinator-seam-FROZEN.md section 3). Any maintenance
        // journal here -- terminal or not -- means the slot does not hold
        // a publication journal at all right now, so the operability fact
        // cannot be read positively. That is a failed read, not a
        // successful one finding nothing: "authoritatively-absent" would
        // wrongly license a pre-write reversal if the destination was in
        // fact operable before maintenance began and archived it out of
        // view.
        const maintenance = readBackendMaintenanceJournal(input.homeDir);
        if (maintenance !== null) {
          return {
            state: "unresolvable" as const,
            reason: MAINTENANCE_HOLDS_LIVE_SLOT_REASON,
          };
        }
        let journal;
        try {
          journal = readBackendPublicationJournal(input.homeDir);
        } catch (error) {
          return { state: "unresolvable" as const, reason: describeUnresolvable(error) };
        }
        if (journal === null || journal.phase !== "completed" || journal.targetBackend !== "postgresql") {
          return { state: "authoritatively-absent" as const };
        }
        let stateSha256: string;
        try {
          stateSha256 = backendPublicationCanonicalSha256(captureBackendPublicationState(input.homeDir));
        } catch (error) {
          return { state: "unresolvable" as const, reason: describeUnresolvable(error) };
        }
        // Exactly the four-field shape PostgreSqlStorageBackendFactory's
        // capturePublicationWitness computes and its caller
        // backendPublicationCanonicalSha256-compares
        // (factory.ts:518-540, :466, :489-495), so both consumers of this
        // fact compare identical bytes, per section 16.
        const valueSha256 = backendPublicationCanonicalSha256({
          journalChecksum: journal.checksumSha256,
          journalPhase: journal.phase,
          targetBackend: journal.targetBackend,
          stateSha256,
        });
        return { state: "present" as const, valueSha256 };
      },
      { allowUnresolved: true, lockToken: input.lockToken },
    );
  } catch (error) {
    return { state: "unresolvable", reason: describeUnresolvable(error) };
  }
}

// ---------------------------------------------------------------------------
// Deterministic identity derivations. Section 8's rule applies to every
// one of these: no attempt-time observation (clock, fencing token, owner
// process id, census/delta digest, watermark) may participate, because
// each of these values must converge across a crash-then-retry rather
// than rotate and cause a permanent refusal.
// ---------------------------------------------------------------------------

/**
 * The maintenance journal's publicationId, and by extension the
 * publicationId field #626 later writes into its own
 * {@link MigrationSelectionBinding} (coordinator-seam-FROZEN.md v7 section
 * 17: "it is the value #626 supplies at enterMaintenance and reads back
 * from the maintenance journal... derive it without any attempt-time
 * observation"). A pure function of the generation id alone: stable
 * across every retry of a rollback on this generation, so
 * enterMaintenance's own recovery-resume comparison
 * (maintenance.publicationId !== input.publicationId) never spuriously
 * refuses a retry, and the later selection-binding write is idempotent
 * because this value never rotates.
 */
export function deriveRollbackPublicationId(generationId: string): string {
  return sha256(canonicalJson(["rollback-publication-v1", generationId]));
}

/**
 * The one construction of a rollback selection binding, shared by the fresh
 * path and both recovery paths so a recovery rewrites byte-identical content.
 * manifestRevision is the revision of the manifest holding the pending
 * publish-rollback effect: the fresh path records the binding right after the
 * effect is begun (and the selection completed), the pending-publish recovery
 * reads it from the pending manifest, and the terminal recovery from the
 * rolled-back manifest one completion later.
 */
function rollbackSelectionBinding(
  generationId: string,
  input: Readonly<{ epochId: string; attemptId: string; manifestRevision: number; terminalEvidenceSha256: string }>,
): MigrationSelectionBinding {
  return {
    kind: "rollback",
    epochId: input.epochId,
    attemptId: input.attemptId,
    manifestRevision: input.manifestRevision,
    witnessChecksumSha256: input.terminalEvidenceSha256,
    publicationId: deriveRollbackPublicationId(generationId),
  };
}

/**
 * The rollback project evidence both the session's lease and the
 * coordinator's compose step carry, so the coordinator adopts the session's
 * lease instead of conflicting with it. One derivation.
 */
export function deriveRollbackProjectEvidenceSha256(input: Readonly<{
  generationId: string;
  publicationId: string;
  localProjectId: string;
  remoteProjectId: string;
}>): string {
  return canonicalSha256({
    version: 1,
    kind: "rollback-project-evidence",
    generationId: input.generationId,
    publicationId: input.publicationId,
    localProjectId: input.localProjectId,
    remoteProjectId: input.remoteProjectId,
  });
}

const ROLLBACK_PUBLISH_EFFECT_ID_PATTERN = /^rollback-publish-([0-9a-f]{64})$/u;

/**
 * plan-v2 section 5 step 7's inputSha256 for prepare-rollback: epoch
 * identity, manifest revision and checksum, generation, and the fenced
 * lease's resource coordinates (constant, never attempt-time). Excludes
 * the fencing token, owner process id, census and delta digests,
 * watermarks and clocks: prepare-rollback is retry-idempotent
 * (protocol.ts's legalEffect) and can never be abandoned, so any rotating
 * input here would make a resume refuse a retry permanently -- exactly
 * the failure plan-v1's inputSha256 produced (plan-v2 section 0) and
 * section 8 forbids generally.
 */
export function deriveRollbackPrepareInputSha256(input: Readonly<{
  generationId: string;
  manifestRevision: number;
  manifestChecksumSha256: string;
  epochId: string;
  resourceType: string;
  resourceKey: string;
}>): string {
  return canonicalSha256([
    "rollback-prepare-input-v1",
    input.generationId,
    input.manifestRevision,
    input.manifestChecksumSha256,
    input.epochId,
    input.resourceType,
    input.resourceKey,
  ]);
}

/**
 * The rollback report's reportId. Excludes attempt-time values on the
 * same grounds as {@link deriveRollbackPrepareInputSha256}: a crash after
 * the report file is durably written but before completeMigrationEffect
 * observes it must regenerate byte-identical content on retry, or the
 * idempotent report write in {@link writeRollbackReport} becomes a
 * permanent refusal. Distinct kind values ("rollback" vs "abandonment")
 * are included so the two reports for one publish-rollback attempt
 * (an authoritative rollback report and, on a later abandonment, an
 * abandonment report) never collide.
 */
export function deriveRollbackReportId(input: Readonly<{
  generationId: string;
  effectId: string;
  kind: "rollback" | "abandonment";
}>): string {
  return sha256(canonicalJson(["rollback-report-v1", input.generationId, input.effectId, input.kind]));
}

// ---------------------------------------------------------------------------
// The durable rollback-authority artifact. donadiosolutions/lcm#1432.
//
// NOT a MigrationReportReference-bound report, deliberately: a report
// inherits the protocol's createdAt-within-[pending.startedAt,completedAt]
// bound (protocol.ts:748-751), which only exists once an effect is
// pending. This artifact must be written BEFORE enterMaintenance (step
// 2) -- before prepare-rollback (step 7) ever begins -- so it can never
// be bound to one. Binding it to prepare-rollback would only have
// closed the window between step 7 and step 8, trading a large hole (any
// crash from step 2 onward) for a smaller one (a crash between step 2
// and step 7, where maintenance is held, no artifact yet exists, and the
// not-yet-completed prepare-rollback effect cannot be abandoned once
// begun) -- that trade is what this design corrects.
//
// Immutable, 0400, private, canonical ASCII with a trailing
// checksumSha256 -- the same D1 discipline every other artifact this
// file writes uses. Deterministic identity keyed on generationId ALONE:
// no clock, fencing token, owner pid, census or delta digest, per
// contract section 8, so a retry rewrites byte-identical content and the
// write is idempotent for free. generationId alone is a sufficient key
// because exactly one artifact is ever legitimate per generationId
// across its entire lifetime: it is written once, before the ONE
// prepare-rollback effect protocol.ts's legalEffect table permits for a
// generationId ever exists (phase "rolling-back" is reachable from
// "verified"/"active" through prepare-rollback only, and "rolled-back",
// the only phase reachable from "rolling-back", is terminal with no
// outbound transition), and every retry before that effect completes is
// retrying that SAME resolution, never a different one.
// ---------------------------------------------------------------------------

const MAX_ROLLBACK_AUTHORITY_ARTIFACT_BYTES = 4 * 1024;

/**
 * Plan-v3.1 A8. What the activation's retained publication says the
 * installation looked like before it ran, persisted so a resume (after the
 * rollback's own publication archives the retained one) compares against the
 * same facts. Only identities and digests: no raw config or map content.
 */
export type RollbackPublicationSource = Readonly<{
  /** The activation publication's id: equal to the activation selection binding's. */
  publicationId: string;
  /** The activation journal's sourceBackend: the backend the rollback must restore. */
  sourceBackend: StorageBackendName;
  /** The covered project's entry in the pre-activation project map. */
  sourceProjectEntry: Readonly<{ localProjectId: string; remoteProjectId: string | null }>;
  sourceConfigSha256: string;
  sourceProjectMapSha256: string;
}>;

export type RollbackAuthorityArtifactBody = Readonly<{
  version: 2;
  generationId: string;
  /**
   * The OperabilityFactResolution this generation's rollback resolved at
   * step 1, before enterMaintenance archived it out of the live slot.
   * Never "unresolvable": an unresolvable operability fact refuses
   * before this artifact is ever written (resolveActivationAuthority's
   * row 4), so nothing reaches the write with that state.
   */
  operabilityFactState: "present" | "authoritatively-absent";
  /** Present only when operabilityFactState is "present". */
  operabilityFactValueSha256: string | null;
  epochId: string;
  attemptId: string;
  publication: RollbackPublicationSource;
  checksumSha256: string;
}>;

/**
 * donadiosolutions/lcm#1432. Deliberately DIFFERENT in shape from
 * {@link deriveRollbackReportId} above: this derives from generationId
 * ALONE, matching the artifact's own "exactly one, ever" identity rule
 * stated in this section's header comment.
 */
export function deriveRollbackAuthorityArtifactId(generationId: string): string {
  return sha256(canonicalJson(["rollback-authority-artifact-v1", generationId]));
}

function rollbackAuthorityArtifactDirectory(homeDir: string): string {
  return join(resolve(homeDir), ".lcm", "migration-rollback-authority");
}

function rollbackAuthorityArtifactPath(homeDir: string, generationId: string): string {
  return join(rollbackAuthorityArtifactDirectory(homeDir), deriveRollbackAuthorityArtifactId(generationId) + ".json");
}

function rollbackAuthorityArtifactChecksum(body: Omit<RollbackAuthorityArtifactBody, "checksumSha256">): string {
  return sha256(canonicalJson(body as unknown as Record<string, unknown>));
}

/**
 * Writes the artifact, idempotently: a retry regenerates byte-identical
 * content (every field is deterministic given the SAME resolved fact and
 * authority) and this function treats an existing file with matching
 * bytes as success. A mismatch -- two DIFFERENT resolutions colliding on
 * one generationId, which can only mean the live fact or authority
 * genuinely changed between writes -- throws rather than silently
 * overwriting immutable evidence.
 */
export function writeRollbackAuthorityArtifact(
  homeDir: string,
  body: Omit<RollbackAuthorityArtifactBody, "checksumSha256">,
): RollbackAuthorityArtifactBody {
  const artifact: RollbackAuthorityArtifactBody = { ...body, checksumSha256: rollbackAuthorityArtifactChecksum(body) };
  const path = rollbackAuthorityArtifactPath(homeDir, body.generationId);
  ensurePrivateDirectory(rollbackAuthorityArtifactDirectory(homeDir));
  try {
    atomicWritePrivateFileDurable(path, canonicalJson(artifact), {
      finalMode: 0o400,
      requireAbsent: true,
      maxExistingBytes: MAX_ROLLBACK_AUTHORITY_ARTIFACT_BYTES,
    });
    return artifact;
  } catch (error) {
    const existing = readRollbackAuthorityArtifact(homeDir, body.generationId);
    if (existing !== null && existing.checksumSha256 === artifact.checksumSha256) return existing;
    throw error;
  }
}

export function readRollbackAuthorityArtifact(
  homeDir: string,
  generationId: string,
): RollbackAuthorityArtifactBody | null {
  const path = rollbackAuthorityArtifactPath(homeDir, generationId);
  let content: string;
  try {
    content = Buffer.from(
      readBoundedRegularFileWithStat(path, {
        allowedRoot: rollbackAuthorityArtifactDirectory(homeDir),
        maxBytes: MAX_ROLLBACK_AUTHORITY_ARTIFACT_BYTES,
        allowedModes: [0o400],
        requireSingleLink: true,
      }).content,
    ).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(content) as RollbackAuthorityArtifactBody;
  const { checksumSha256, ...rest } = parsed;
  if (rollbackAuthorityArtifactChecksum(rest) !== checksumSha256) {
    throw new MigrationProtocolError("checksum-mismatch", "rollback authority artifact checksum does not match");
  }
  if (parsed.version !== 2) {
    // A version-1 artifact predates the retained publication source (A8); it is never rewritten, so a
    // rollback that began under it cannot be continued.
    throw new RollbackOrchestrationError(
      "unexpected-state",
      "the rollback authority artifact is version " + String(parsed.version)
        + ", which predates the persisted publication source; it cannot be continued or rewritten",
    );
  }
  return parsed;
}

function sameOperabilityFactValue(
  live: Readonly<{ state: "present" | "authoritatively-absent"; valueSha256?: string }>,
  artifact: RollbackAuthorityArtifactBody,
): boolean {
  if (live.state !== artifact.operabilityFactState) return false;
  if (live.state === "present") return live.valueSha256 === artifact.operabilityFactValueSha256;
  return true;
}

/**
 * donadiosolutions/lcm#1432. The single reader every rollback code path
 * uses to resolve the operability fact, so the fallback-and-cross-check
 * rule is implemented exactly once rather than once per call site:
 *
 * 1. A resolvable live read (present/authoritatively-absent) is used,
 *    and cross-checked against the durable artifact when one already
 *    exists -- disagreement refuses rather than preferring either side,
 *    per section 15's "compared as a value, never inferred from
 *    ordering or timing" discipline.
 * 2. An unresolvable live read falls back to the durable artifact ONLY
 *    when the reason is EXACTLY MAINTENANCE_HOLDS_LIVE_SLOT_REASON --
 *    the expected, structural cause once this rollback's own
 *    enterMaintenance has run -- never any other unresolvable cause
 *    (lock contention, malformed journal, ...), which stays a refusal.
 * 3. No artifact and an unresolvable live read for that expected reason
 *    refuses: structurally this should not happen for THIS generation's
 *    own maintenance (the artifact is always written before its
 *    enterMaintenance call), so it can only mean the live slot is held
 *    by something unrelated to this rollback, and there is nothing to
 *    recover from.
 *
 * donadiosolutions/lcm#1555. One opt-in substitution, passed only by
 * recoverPendingPublishRollback's row for this rollback's own externally
 * aborted publication: when the RAW live read is authoritatively-absent
 * and the artifact exists, the artifact's recorded fact stands in for it,
 * before the disagreement check above. This rollback's own enterMaintenance
 * archived the activation's completed publication, and the rollback's own
 * (aborted) publication now occupies the live slot, so the live slot can no
 * longer show the positive fact the artifact recorded. A live read that is
 * unresolvable, or no artifact, is never substituted.
 */
async function resolveRollbackOperabilityFact(
  input: Readonly<{ homeDir: string; generationId: string; ownAbortedPublication?: true }>,
): Promise<Readonly<{ fact: OperabilityFactResolution; artifact: RollbackAuthorityArtifactBody | null }>> {
  const live = await readBackendPublicationOperabilityFact({ homeDir: input.homeDir });
  const artifact = readRollbackAuthorityArtifact(input.homeDir, input.generationId);
  if (input.ownAbortedPublication === true && live.state === "authoritatively-absent" && artifact !== null) {
    return { fact: artifactOperabilityFact(artifact), artifact };
  }
  if (live.state !== "unresolvable") {
    if (artifact !== null && !sameOperabilityFactValue(live, artifact)) {
      return {
        fact: {
          state: "unresolvable",
          reason: "the live operability fact disagrees with the durable rollback-authority artifact",
        },
        artifact,
      };
    }
    return { fact: live, artifact };
  }
  if (live.reason !== MAINTENANCE_HOLDS_LIVE_SLOT_REASON) {
    return { fact: live, artifact };
  }
  if (artifact === null) {
    return {
      fact: {
        state: "unresolvable",
        reason: "backend maintenance holds the live publication slot and no durable "
          + "rollback-authority artifact exists to recover the fact from",
      },
      artifact: null,
    };
  }
  return {
    fact: artifactOperabilityFact(artifact),
    artifact,
  };
}

/** The operability fact the durable rollback-authority artifact recorded. */
function artifactOperabilityFact(artifact: RollbackAuthorityArtifactBody): OperabilityFactResolution {
  return artifact.operabilityFactState === "present"
    ? { state: "present", valueSha256: artifact.operabilityFactValueSha256! }
    : { state: "authoritatively-absent" };
}

/**
 * donadiosolutions/lcm#1432. The artifact is immutable and every reader
 * only reads it, never rewrites it -- but it is not blindly trusted
 * either: this cross-checks the authority recomputed from a FRESH
 * Boundary A read (independent of the archived-publication-slot problem
 * resolveRollbackOperabilityFact exists to recover from) against the
 * epoch/attempt the artifact recorded, and refuses rather than
 * preferring either side when they disagree. A null artifact (the first
 * time this generationId's rollback ever reaches this point) has nothing
 * to check against and is not an error.
 */
function assertAuthorityAgreesWithArtifact(
  authority: Exclude<ActivationAuthority, Readonly<{ status: "refused"; reason: string }>>,
  artifact: RollbackAuthorityArtifactBody | null,
): asserts authority is AuthoritativeActivation {
  // A rollback in progress began from an authoritative activation (an unactivated generation is refused before
  // anything is written), so an unactivated reading now contradicts it.
  if (authority.status === "unactivated") {
    throw new RollbackOrchestrationError(
      "unexpected-state",
      "freshly resolved authority is unactivated but a rollback is in progress for an authoritative activation",
    );
  }
  if (artifact === null) return;
  if (
    authority.selection.epochId !== artifact.epochId
    || authority.selection.attemptId !== artifact.attemptId
  ) {
    throw new RollbackOrchestrationError(
      "unexpected-state",
      "freshly resolved authority disagrees with the durable rollback-authority artifact's "
        + "recorded epoch/attempt",
    );
  }
}

// ---------------------------------------------------------------------------
// Boundary D. coordinator-seam-FROZEN.md v7 section 17. The writer is
// generation-binding-store.ts's recordMigrationSelectionBinding (the default
// below); #626 persists nothing through any other path, per section 17's
// explicit "two independent writers" prohibition.
// Synchronous, per section 17: an async writer inside the retained fenced
// window invites the suspend-across-await hazard the lock seam itself was
// just fixed to avoid.
// ---------------------------------------------------------------------------

export type MigrationSelectionBindingRecorder = (
  input: Readonly<{ homeDir: string; generationId: string; binding: MigrationSelectionBinding }>,
) => void;

// ---------------------------------------------------------------------------
// Boundary E. Fetches the full epoch and attempt records an authoritative
// selection names (plan-v3.1 amendment A4), plus the witness it names. Null
// only for a store lacking the pair; an unreadable store throws.
// ---------------------------------------------------------------------------

export type RollbackAuthoritativeContextResolver = (
  input: Readonly<{
    homeDir: string;
    generationId: string;
    epochId: string;
    attemptId: string;
    witnessChecksumSha256?: string;
  }>,
) => Promise<RollbackAuthoritativeContext | null>;

// ---------------------------------------------------------------------------
// Boundary F. See this file's module doc comment for why this is one
// injected capability rather than PostgreSQL plumbing #626 builds here.
// ---------------------------------------------------------------------------

/** One fenced PostgreSQL session, retained across steps 3 through 10. */
export interface RollbackFencedSession {
  /** witness-schema-FROZEN-v2.md section 2 shape, minted at lease acquisition (step 3). */
  readonly selectionAuthority: MigrationSelectionAuthority;
  readonly quiescenceFenceEvidenceSha256: string;
  /** Re-asserts the same fencingToken before a durable step, per contract section 5. */
  renew(): Promise<void>;
  /**
   * One dedicated-snapshot readback (plan-v2 section 5 steps 4 and 10).
   * The implementation captures the delta and, only if it is
   * found equal to the baseline within this same snapshot, the census --
   * plan-v2 section 4's "the census when the delta is equal", read from
   * the identical transaction rather than a second one.
   */
  captureReadback(input: Readonly<{
    canonicalDeltaBaseline: MigrationCanonicalDelta;
    /**
     * Capture the census even when the delta differs from the baseline.
     * Step 10 of a post-write rollback sets this: it must reproduce the
     * export snapshot's census exactly (plan-v3.1 amendment A6), which a
     * changed delta alone cannot show. Omitted, the census is captured only
     * when the delta equals the baseline.
     */
    requireCensus?: boolean;
  }>): Promise<RollbackEligibilityObservation>;
  /**
   * Opens the source #626 exports from for post-write generation build,
   * together with the canonical delta and census vector of the very
   * snapshot it reads (one derivation, plan-v3.1 amendments A6 and A11).
   */
  openPortableSource(): Promise<RollbackExportSource>;
  /**
   * EXTENSION added by this item's continuation (see the standalone doc
   * comment above ComputeRollbackTerminalEvidenceInput for why). Not part
   * of the originally committed interface.
   */
  computeRollbackTerminalEvidenceSha256(input: ComputeRollbackTerminalEvidenceInput): string;
  /**
   * Call once, right before the coordinator can acquire the lease for the
   * rollback publication. From then on release() only verifies that the row
   * is present and released; it never releases it itself (seam section 19).
   */
  markCoordinatorAcquired(): void;
  /**
   * Closes the owned resources only and leaves the PostgreSQL lease held. Called instead of release() once the
   * maintenance selection has been attempted: until the coordinator's publication completes, a released lease
   * would admit guarded writers while a selection toward sqlite is pending.
   */
  closeKeepingLease(): Promise<void>;
  release(): Promise<void>;
}

/** The export stream and the evidence of the snapshot it reads. */
export type RollbackExportSource = Readonly<{
  stream: PortableRecordStream;
  canonicalDelta: MigrationCanonicalDelta;
  censusVector: MigrationCensusVector;
}>;

export type OpenRollbackFencedSession = (
  input: Readonly<{
    homeDir: string;
    manifest: MigrationManifest;
    /** The retained append-barrier token of the rollback window (quiescence is asserted under it). */
    lockToken: BackendPublicationLockToken;
    scratchParent?: string;
    signal?: AbortSignal;
    /**
     * Set when the session is opened to recover a rollback whose maintenance selection was already attempted
     * (#626 F11). Admission then accepts this rollback's own later journal phases instead of requiring a freshly
     * held maintenance, and a failed open keeps the lease instead of releasing it.
     */
    recovery?: true;
  }>,
) => Promise<RollbackFencedSession>;

// ---------------------------------------------------------------------------
// Report persistence. #624's D1 convention (plan-v1 section 4, carried
// into plan-v2 section 5's closing paragraph): immutable 0400 private
// JSON at <homeDir>/.lcm/migration-reports/<generationId>/<reportId>.json,
// canonical ASCII with a trailing checksumSha256, createdAt kept OUT of
// the hashed body (it lives only in the MigrationReportReference the
// manifest carries), so a crash-then-retry regenerates byte-identical
// content and the write below is genuinely idempotent rather than merely
// retried.
// ---------------------------------------------------------------------------

export type RollbackReportBody = Readonly<{
  version: 1;
  reportId: string;
  generationId: string;
  effectId: string;
  kind: "rollback" | "abandonment";
  /** Recorded separately from the protocol mode, per plan-v2 section 5's
   * closing paragraph. */
  eligibility: "pre-write" | "post-write" | null;
  mode: "pre-write" | "post-write" | null;
  epochId: string | null;
  attemptId: string | null;
  /** backend-publication.ts:3765-3780's sealed material digest, binding
   * which publication material this report's rollback prepared -- so a
   * later abandonment can prove exactly what was prepared. Null for an
   * abandonment report itself (there is no sealed material once
   * abandoned). */
  sealedPublicationMaterialDigestSha256: string | null;
  /** Present only for kind "abandonment". */
  reason: string | null;
  /**
   * The manifest revision the rollback selection binding was recorded at, persisted so terminal recovery
   * rewrites the identical binding. Null for an abandonment.
   */
  selectionBindingManifestRevision: number | null;
  checksumSha256: string;
}>;

function reportPath(homeDir: string, generationId: string, reportId: string): string {
  return join(resolve(homeDir), ".lcm", "migration-reports", generationId, reportId + ".json");
}

function reportChecksum(body: Omit<RollbackReportBody, "checksumSha256">): string {
  return sha256(canonicalJson(body as unknown as Record<string, unknown>));
}

/**
 * Writes the report, idempotently: a retry after a crash between the
 * write and completeMigrationEffect observing it regenerates
 * byte-identical content (every field here is deterministic, per this
 * file's derivation functions above) and this function treats an
 * existing file with matching bytes as success rather than an error. A
 * mismatch -- which can only mean two DIFFERENT reports collided on one
 * reportId, a derivation bug -- throws rather than silently overwriting
 * immutable evidence.
 */
export function writeRollbackReport(
  homeDir: string,
  body: Omit<RollbackReportBody, "checksumSha256">,
): RollbackReportBody {
  const report: RollbackReportBody = { ...body, checksumSha256: reportChecksum(body) };
  const path = reportPath(homeDir, body.generationId, body.reportId);
  ensurePrivateDirectory(join(resolve(homeDir), ".lcm", "migration-reports", body.generationId));
  try {
    atomicWritePrivateFileDurable(path, canonicalJson(report), {
      finalMode: 0o400,
      requireAbsent: true,
      maxExistingBytes: MAX_REPORT_BYTES,
    });
    return report;
  } catch (error) {
    const existing = readRollbackReport(homeDir, body.generationId, body.reportId);
    if (existing !== null && existing.checksumSha256 === report.checksumSha256) return existing;
    throw error;
  }
}

export function readRollbackReport(
  homeDir: string,
  generationId: string,
  reportId: string,
): RollbackReportBody | null {
  const path = reportPath(homeDir, generationId, reportId);
  let content: string;
  try {
    content = Buffer.from(
      readBoundedRegularFileWithStat(path, {
        allowedRoot: join(resolve(homeDir), ".lcm", "migration-reports", generationId),
        maxBytes: MAX_REPORT_BYTES,
        allowedModes: [0o400],
        requireSingleLink: true,
      }).content,
    ).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(content) as RollbackReportBody;
  const { checksumSha256, ...rest } = parsed;
  if (reportChecksum(rest) !== checksumSha256) {
    throw new MigrationProtocolError("checksum-mismatch", "rollback report checksum does not match");
  }
  return parsed;
}


// ---------------------------------------------------------------------------
// Boundary D2 (coordinator-seam-FROZEN.md v9 section 18, added since
// Boundary D above was written). recordMigrationSelectionBinding's twin
// for the WITNESS binding. Same ownership rule as Boundary D: #625
// implements it, #626 consumes it injected, #626 persists nothing itself.
// Ordering differs from Boundary D's -- a witness binding is written
// BEFORE its selection is prepared (it is evidence an attempt happened),
// never after (section 18: "ordering differs from section 17's, and the
// difference is the whole point of the witness/selection split"). See
// runMigrationRollback below for exactly where this item calls it.
//
// NOTE (v9 amendment): witnessChecksumSha256 is not recomputable by this
// writer, so this file must not assume the store re-derives or
// authenticates that digest -- #626 computes it (see
// RollbackFencedSession.computeRollbackTerminalEvidenceSha256 below) and
// the writer is trusted to store exactly what it is given.
// ---------------------------------------------------------------------------

export type MigrationActivationWitnessRecorder = (
  input: Readonly<{ homeDir: string; generationId: string; witness: MigrationActivationWitness }>,
) => void;

export type MigrationWitnessBindingRecorder = (
  input: Readonly<{ homeDir: string; generationId: string; binding: MigrationWitnessBinding }>,
) => void;

// ---------------------------------------------------------------------------
// EXTENSION TO BOUNDARY F. coordinator-seam-FROZEN.md section 4's
// terminalEvidenceSha256 is "the checksumSha256 of the
// MigrationActivationWitness of frozen witness schema v3 section 8", which
// only the code that holds the live capture can mint with
// createMigrationActivationWitness. So the injected session computes it from
// values this orchestration legitimately has (epoch/attempt identity, the
// fresh observation, and this item's own eligibility decision) rather than
// this file hand-deriving a digest that activation-witness.ts owns.
// ---------------------------------------------------------------------------

export type ComputeRollbackTerminalEvidenceInput = Readonly<{
  /** The activation records the rollback unwinds. */
  epoch: MigrationActivationEpoch;
  attempt: MigrationActivationAttempt;
  observation: RollbackEligibilityObservation;
  mode: "pre-write" | "post-write";
}>;

/** @internal Exported for direct unit testing only; not part of the module's public surface. */
export type RollbackTerminalEvidenceComputer = (
  input: ComputeRollbackTerminalEvidenceInput,
) => string;



// ---------------------------------------------------------------------------
// Orchestration. plan-v2 section 5's twelve steps. The retained local
// token spans steps 2 through 12, which this function implements as one
// call to withBackendPublicationAppendBarrierAsync wrapping steps 2-12's
// entire body -- the token this file's own coordinator methods accept is
// only valid inside that callback (see backend-publication.ts's
// activeAppendBarrierTokens lifecycle), so "retained across the window"
// means "the window's code runs inside the one callback", not that the
// token is threaded out and reused across separate acquisitions.
// ---------------------------------------------------------------------------

export interface RunMigrationRollbackDependencies {
  /** Over the production driver: rollback-inputs.ts's entry builds it. Tests inject a coordinator over an in-memory driver. */
  readonly coordinator: BackendPublicationCoordinator;
  /** Boundary F. */
  readonly openFencedSession: OpenRollbackFencedSession;
  /** Boundary A. Defaults to resolveMigrationWitnessBindings. */
  readonly resolveWitnessBindings?: MigrationWitnessResolver;
  /** Activation evidence store read. Defaults to readMigrationActivationEvidence. */
  readonly resolveActivationEvidence?: ActivationEvidenceResolver;
  /** Boundary D. Defaults to recordMigrationSelectionBinding. */
  readonly recordSelectionBinding?: MigrationSelectionBindingRecorder;
  /** Boundary D2. Defaults to recordMigrationWitnessBinding. */
  readonly recordWitnessBinding?: MigrationWitnessBindingRecorder;
  /** Boundary E. Defaults to resolveRollbackAuthoritativeContext. */
  readonly resolveAuthoritativeContext?: RollbackAuthoritativeContextResolver;
  /** The project map the single-project check (plan-v3.2 A14) reads. Defaults to readProjectMapSnapshot. */
  readonly readProjectMap?: typeof readProjectMapSnapshot;
  /** The activation's retained publication (A8), read before the rollback's own publication. Defaults to readRetainedBackendPublicationMaterial. */
  readonly readRetainedMaterial?: typeof readRetainedBackendPublicationMaterial;
  /** Derives the rollback publication's material and projects from the live files. Defaults to composeBackendPublicationMaterial. */
  readonly composePublication?: typeof composeBackendPublicationMaterial;
  /** Records the rollback witness in the evidence store (A9 step 1). Defaults to recordMigrationActivationWitness. */
  readonly recordActivationWitness?: MigrationActivationWitnessRecorder;
  /** Flushes a directory after the install's renames (F3). Defaults to installRollbackGeneration's own. */
  readonly syncDirectory?: (path: string) => void;
}

type ResolvedRollbackDependencies = Required<RunMigrationRollbackDependencies>;

function withDefaultDependencies(
  deps: Readonly<RunMigrationRollbackDependencies>,
): Readonly<ResolvedRollbackDependencies> {
  return {
    coordinator: deps.coordinator,
    openFencedSession: deps.openFencedSession,
    resolveWitnessBindings: deps.resolveWitnessBindings ?? resolveMigrationWitnessBindings,
    resolveActivationEvidence: deps.resolveActivationEvidence ?? readMigrationActivationEvidence,
    recordSelectionBinding: deps.recordSelectionBinding ?? recordMigrationSelectionBinding,
    recordWitnessBinding: deps.recordWitnessBinding ?? recordMigrationWitnessBinding,
    resolveAuthoritativeContext: deps.resolveAuthoritativeContext ?? resolveRollbackAuthoritativeContext,
    readProjectMap: deps.readProjectMap ?? readProjectMapForRollback,
    readRetainedMaterial: deps.readRetainedMaterial ?? readRetainedBackendPublicationMaterial,
    composePublication: deps.composePublication ?? composeBackendPublicationMaterial,
    recordActivationWitness: deps.recordActivationWitness ?? recordMigrationActivationWitness,
    syncDirectory: deps.syncDirectory ?? ((path: string) => syncPrivateDirectory(path)),
  };
}

/**
 * Plan-v3.2 A14. The maintenance selection flip is global: it moves the
 * whole installation's backend selection to sqlite. Another remotely bound
 * project would be silently stranded on a backend it no longer routes to, so
 * a rollback is only offered when the covered project is the one and only
 * project the project map binds to PostgreSQL. Two observations must agree --
 * the map's entries and the covered project (its local id and, when shared,
 * its remote id) -- and either one alone being wrong refuses. An unreadable
 * map refuses too. A local-only entry (no remoteProjectId) never blocks.
 */
export type OwnPublicationSource = Readonly<{ storage: ResolvedStorageConfig; projectMap: ProjectMap }>;

function decodeRecoveryFile(file: BackendPublicationRecoveryFile): string {
  if (file.presence !== "present") {
    throw new RollbackOrchestrationError("unexpected-state", "the rollback's publication sealed no source file where one is required");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(file.content);
}

/**
 * E6/E7. This rollback's own publication journal with no recovery reference: still at preparing (prepare() wrote
 * the journal and died before or after the material seal, before the prepared checkpoint recorded the reference)
 * or aborted straight from that state by the coordinator's missing-material exit. The authenticated material
 * reader refuses such a journal by design, and nothing has been published or fenced from it: the live configuration
 * and project map are still the pre-rollback source. Recognized only for the rollback's composition (postgresql to
 * sqlite, exactly the covered project); any other unreferenced journal is left to the authenticated reader's
 * refusal, and an aborted journal that had sealed its material is not this (see isOwnConsumedMaterialJournal).
 */
function isOwnUnsealedJournal(journal: BackendPublicationJournal, publicationId: string, localProjectId: string): boolean {
  return (journal.phase === "preparing" || journal.phase === "aborted")
    && journal.recoveryReference === null
    && isOwnRollbackShape(journal, publicationId, localProjectId);
}

/** The rollback's composition as the source readers can know it: postgresql to sqlite, exactly the covered project. */
function isOwnRollbackShape(journal: BackendPublicationJournal, publicationId: string, localProjectId: string): boolean {
  return journal.publicationId === publicationId
    && journal.sourceBackend === "postgresql"
    && journal.targetBackend === "sqlite"
    && journal.projects.length === 1
    && journal.projects[0]!.localProjectId === localProjectId;
}

/**
 * #1555. This rollback's own publication after an abort that had sealed its material: the coordinator's abort
 * restores the configuration and the project map, releases what it recorded and consumes the material
 * (backend-publication.ts #abortUnlocked: restoreConfig, restoreMap, #releaseAll, #cleanupMaterial, then aborted),
 * so a journal at aborted with its reference, or at abort-releasing once the material file is gone (the crash
 * window between the cleanup and the aborted checkpoint), has no sealed source to authenticate. Its source is the
 * live files the abort restored, which the reader checks against the journal's witnesses. At abort-releasing with
 * the material still present the authenticated reader decides, as before.
 */
function isOwnConsumedMaterialJournal(
  journal: BackendPublicationJournal,
  homeDir: string,
  publicationId: string,
  localProjectId: string,
): boolean {
  return isOwnRollbackShape(journal, publicationId, localProjectId)
    && (journal.phase === "aborted"
      || (journal.phase === "abort-releasing" && unsealedPublicationMaterialAbsent(homeDir, publicationId)));
}

/**
 * E6. The journal the coordinator's missing-material exit leaves behind (preparing with no reference, material
 * absent, aborted directly): no fence was recorded and nothing was published, so the rollback composes and prepares
 * its publication again. An aborted journal that had sealed its material is a different thing and is not touched.
 */
function isAbortedUnsealedJournal(journal: BackendPublicationJournal): boolean {
  return journal.phase === "aborted" && journal.recoveryReference === null;
}

/**
 * E8. Whether the material of this rollback's publication is absent at the coordinator's deterministic path
 * (authenticateMaterial requires exactly `<publicationId>.material` under the publication directory). Only an
 * ENOENT at that path establishes absence; a present entry does not, and any other error propagates.
 */
function unsealedPublicationMaterialAbsent(homeDir: string, publicationId: string): boolean {
  return lstatSync(join(backendPublicationDirectory(homeDir), publicationId + ".material"), { throwIfNoEntry: false }) === undefined;
}

/** The decoded pre-rollback source files of this rollback's own publication. */
type OwnPublicationSourceFiles = Readonly<{ config: string; projectMap: string }>;

/**
 * E6/E7. The source files of this rollback's own unsealed publication (preparing, or aborted from preparing without
 * a reference). The coordinator observed the live configuration and project map when it wrote that journal
 * (sourceState, carried unchanged into the aborted transition) and has mutated neither since, so the live files are
 * the source -- read privately (the ordinary readers refuse any in-flight or unreferenced publication) and accepted
 * only byte-for-byte as the journal witnessed them. #1555 reads the files a completed abort restored the same way
 * (sourceState then witnesses the restored files, raw bytes and length): a later edit of either file refuses.
 */
function readUnsealedPublicationSource(homeDir: string, journal: BackendPublicationJournal): OwnPublicationSourceFiles {
  const root = lcmHomeDir(homeDir);
  const read = (name: string, expected: BackendPublicationFileWitness, field: string): string => {
    const observed = captureBackendPublicationFileWitness(join(root, name), root);
    if (
      observed.content === null
      || expected.presence !== "present"
      || observed.witness.rawSha256 !== expected.rawSha256
      || observed.witness.byteLength !== expected.byteLength
    ) {
      throw new RollbackOrchestrationError(
        "unexpected-state",
        "the live " + field + " is not the one the rollback's publication witnessed as its source",
      );
    }
    return observed.content;
  };
  return {
    config: read("config.json", journal.sourceState.config, "configuration"),
    projectMap: read("map.json", journal.sourceState.projectMap, "project map"),
  };
}

/**
 * The configuration and project map as they were before this rollback's own publication, read from the
 * authenticated recovery material that publication sealed; null when no publication of this rollback is in the
 * live slot. Once the publication has begun the live files and the
 * consumer reads are the rollback's in-flight state -- the config selects sqlite, the project is unbound, and the
 * consumer read refuses an unresolved publication -- so every re-run reads its inputs from this sealed source.
 * A journal without a reference -- still at preparing, or aborted straight from it (E6/E7) -- has sealed nothing
 * and published nothing: its source is read from the live files, matched against the witnesses it recorded.
 * An abort of this rollback's publication that already restored the files and consumed the sealed material
 * (phase aborted with a reference, or abort-releasing with the material gone) has no sealed source left to read
 * either; the live files stand in for it, accepted only byte-for-byte as the journal witnessed them (#1555).
 */
function readOwnPublicationSourceFiles(homeDir: string, publicationId: string, localProjectId: string): OwnPublicationSourceFiles | null {
  // While maintenance holds the live slot no publication journal is readable, and none of this rollback's exists.
  if (readBackendMaintenanceJournal(homeDir) !== null) return null;
  const journal = readBackendPublicationJournal(homeDir);
  if (journal === null || journal.publicationId !== publicationId) return null;
  if (isOwnUnsealedJournal(journal, publicationId, localProjectId)) return readUnsealedPublicationSource(homeDir, journal);
  if (isOwnConsumedMaterialJournal(journal, homeDir, publicationId, localProjectId)) {
    return readUnsealedPublicationSource(homeDir, journal);
  }
  if (journal.phase === "aborted") return null;
  const material = readAuthenticatedBackendPublicationMaterial(journal, homeDir);
  return { config: decodeRecoveryFile(material.source.config), projectMap: decodeRecoveryFile(material.source.projectMap) };
}

/** The sealed pre-rollback project map of the rollback's own publication, or null when it is not in the live slot. */
function readOwnPublicationProjectMap(homeDir: string, publicationId: string, localProjectId: string): ProjectMap | null {
  const source = readOwnPublicationSourceFiles(homeDir, publicationId, localProjectId);
  return source === null ? null : parseProjectMap(source.projectMap);
}

/** The sealed pre-rollback configuration and project map of the rollback's own publication, or null. */
export function readOwnPublicationSourceFromMaterial(homeDir: string, publicationId: string, localProjectId: string): OwnPublicationSource | null {
  const source = readOwnPublicationSourceFiles(homeDir, publicationId, localProjectId);
  if (source === null) return null;
  return {
    storage: parseDaemonConfig(source.config, undefined, resolveDaemonConfigEnv()).storage,
    projectMap: parseProjectMap(source.projectMap),
  };
}

/**
 * The project map as a rollback reads it: while a rollback is underway the publication slot is held or in flight
 * (the very states a re-run recovers), and the consumer read refuses any unresolved publication, so this reader
 * admits them. It reads the live map, never writes it.
 */
export const readProjectMapForRollback: typeof readProjectMapSnapshot = (homeDir, publicationLockToken) =>
  withBackendPublicationConsumerLock(
    homeDir,
    (token) => readProjectMapSnapshot(homeDir, token),
    { allowUnresolved: true, lockToken: publicationLockToken },
  );

function assertCoveredProjectIsSoleRemoteBinding(
  deps: Readonly<ResolvedRollbackDependencies>,
  input: Readonly<RunMigrationRollbackInput>,
  token?: BackendPublicationLockToken,
): string {
  let map: ReturnType<typeof readProjectMapSnapshot>;
  try {
    map = readOwnPublicationProjectMap(input.homeDir, deriveRollbackPublicationId(input.generationId), input.localProjectId)
      ?? deps.readProjectMap(input.homeDir, token);
  } catch (error) {
    throw new RollbackOrchestrationError(
      "not-eligible",
      "project-map-unreadable: the project map cannot be read, so other remotely bound projects cannot be ruled out: "
        + describeUnresolvable(error),
    );
  }
  const covered = map[input.localProjectId];
  if (covered?.remoteProjectId === undefined) {
    throw new RollbackOrchestrationError(
      "not-eligible",
      "covered-project-unbound: the project map does not bind the covered project to PostgreSQL; a generation that never "
        + "activated is left with lcm migration abort",
    );
  }
  if (input.projectIdentity.scope === "shared" && covered.remoteProjectId !== input.projectIdentity.projectId) {
    throw new RollbackOrchestrationError(
      "not-eligible",
      "covered-project-mismatch: the project map binds the covered project to a different PostgreSQL project",
    );
  }
  const others = Object.entries(map).filter(
    ([hash, entry]) => hash !== input.localProjectId && entry.remoteProjectId !== undefined,
  );
  if (others.length > 0) {
    throw new RollbackOrchestrationError(
      "not-eligible",
      "multiple-remote-projects: rolling back would also reroute " + others.length
        + " other remotely bound project(s) (" + others.map(([hash]) => hash).join(", ")
        + "); reduce the installation to one remotely bound project first",
    );
  }
  return covered.remoteProjectId;
}

export interface RunMigrationRollbackInput {
  readonly homeDir: string;
  readonly generationId: string;
  /** The live canonical SQLite database path this rollback installs into. */
  readonly canonicalPath: string;
  readonly projectIdentity: PortableProjectIdentity;
  /** StorageIdentityContext.localProjectId -- see rollback-sidecars.ts's module doc on why this is separate from projectIdentity. */
  readonly localProjectId: string;
  readonly sourceSelectionSha256: string;
  readonly queueEvidenceSha256: string;
  readonly roster: readonly BackendMaintenanceRosterEntry[];
  readonly scratchParent?: string;
  readonly signal?: AbortSignal;
  /** @internal Clock seam for tests. */
  readonly _now?: () => Date;
  /** @internal Scan-bound seam for tests (defaults to MAX_ROLLBACK_GENERATION_BUILD_ATTEMPT_ENTRIES). */
  readonly _maxBuildAttemptEntries?: number;
}

export type RollbackOrchestrationErrorReason =
  | "not-eligible"
  | "drift"
  | "unexpected-state"
  | "not-implemented";

export class RollbackOrchestrationError extends Error {
  constructor(
    readonly reason: RollbackOrchestrationErrorReason,
    message: string = reason,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RollbackOrchestrationError";
  }
}

export type RunMigrationRollbackOutcome = Readonly<{
  manifest: MigrationManifest;
  report: RollbackReportBody | null;
}>;

function sameSuccessorManifest(a: MigrationManifest, b: MigrationManifest): boolean {
  const strip = (value: MigrationManifest) => ({
    ...value,
    checksumSha256: null,
    updatedAt: null,
    pendingEffect: value.pendingEffect === null ? null : { ...value.pendingEffect, startedAt: null },
  });
  return canonicalJson(strip(a) as unknown as Record<string, unknown>)
    === canonicalJson(strip(b) as unknown as Record<string, unknown>);
}

/**
 * Publishes a computed successor manifest, tolerating a retry that already
 * landed the identical successor (compared modulo timestamps/checksum, per
 * batch-copy.ts's own sameSuccessor discipline for the identical reason:
 * this orchestration's retry paths recompute deterministic inputs and must
 * not refuse when their own prior attempt already published the result).
 */
function publishManifest(
  store: MigrationManifestStore,
  generationId: string,
  current: MigrationManifest,
  next: MigrationManifest,
): MigrationManifest {
  try {
    return store.update(generationId, current.checksumSha256, () => next);
  } catch (error) {
    const observed = store.read(generationId);
    if (!sameSuccessorManifest(observed, next)) throw error;
    return observed;
  }
}



/**
 * Orchestrates one rollback attempt for a manifest at its generationId,
 * per plan-v2 section 5's twelve steps.
 *
 * SCOPE OF THIS IMPLEMENTATION, stated honestly rather than silently
 * narrowed (see this item's status report for the full account):
 *
 *  - Fully implemented: step 1's recovery classification and its three
 *    branches (fresh start, resume a pending prepare-rollback, continue a
 *    completed prepare-rollback with no pending effect); steps 2-8 for
 *    every eligibility outcome; step 9/11's post-write generation
 *    build+install+materialize path; step 9/11's pre-write
 *    selection-reversal path -- no build, no install, no
 *    sidecar materialization, no generation directory, per plan-v2
 *    section 1's "Data movement: none" for pre-write and issue
 *    #626's acceptance ("an exact selection reversal with no data
 *    copy") -- corrected in this continuation from a predecessor's
 *    blanket "not-implemented" refusal for every non-post-write mode,
 *    which this file's own module doc's Boundary section had wrongly
 *    reasoned required resolving the #622-preserved source generation's
 *    on-disk path; step 12's report persistence and effect completion
 *    for both the post-write and pre-write paths. A generation that never
 *    activated is refused before any of these steps (nothing to unwind).
 *  - NOT implemented: nothing at step 9 or step 11 remains unimplemented
 *    for any eligibility. The maintenance-selection flip
 *    (prepareMaintenanceSelection / completeMaintenanceSelection) is
 *    unconditional across every eligibility, which is what makes
 *    pre-write a real "selection reversal" rather than a
 *    no-op.
*  - Best-effort, flagged as needing review rather than presented as
*    settled: step 12's abandonment path's explicit backend-selection
*    reconciliation (see recoverPendingPublishRollback below).
*/

/**
 * donadiosolutions/lcm#1432. True only when "existing" is a durable,
 * non-terminal maintenance journal that matches every field THIS
 * generationId's rollback would itself supply to enterMaintenance --
 * meaning it can only be OUR OWN maintenance, held by a crashed prior
 * attempt of this SAME rollback, never a different or unrelated one.
 * Deliberately conservative: any mismatch (including roster order,
 * compared order-invariantly below) falls through to calling
 * enterMaintenance normally, which refuses loudly rather than this
 * function silently adopting a maintenance it cannot prove is ours.
 */
function maintenanceAlreadyHeldForThisAttempt(
  existing: BackendMaintenanceJournal | null,
  attempt: Readonly<{
    publicationId: string;
    generationId: string;
    sourceBackend: StorageBackendName;
    sourceSelectionSha256: string;
    queueEvidenceSha256: string;
    roster: readonly BackendMaintenanceRosterEntry[];
  }>,
): boolean {
  if (existing === null || existing.phase !== "maintenance-held") return false;
  return existing.publicationId === attempt.publicationId
    && existing.generationId === attempt.generationId
    && existing.sourceBackend === attempt.sourceBackend
    && existing.sourceSelectionSha256 === attempt.sourceSelectionSha256
    && existing.queueEvidenceSha256 === attempt.queueEvidenceSha256
    && sameMaintenanceRoster(existing.roster, attempt.roster);
}

function sortedMaintenanceRoster(
  roster: readonly BackendMaintenanceRosterEntry[],
): readonly BackendMaintenanceRosterEntry[] {
  return [...roster].sort((a, b) => (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0));
}

function sameMaintenanceRoster(
  left: readonly BackendMaintenanceRosterEntry[],
  right: readonly BackendMaintenanceRosterEntry[],
): boolean {
  return canonicalJson(sortedMaintenanceRoster(left) as unknown as readonly Record<string, unknown>[])
    === canonicalJson(sortedMaintenanceRoster(right) as unknown as readonly Record<string, unknown>[]);
}

export async function runMigrationRollback(
  input: Readonly<RunMigrationRollbackInput>,
  suppliedDeps: Readonly<RunMigrationRollbackDependencies>,
): Promise<RunMigrationRollbackOutcome> {
  const deps = withDefaultDependencies(suppliedDeps);
  const now = input._now ?? ((): Date => new Date());
  const store = new MigrationManifestStore({ homeDir: input.homeDir });
  const current = store.read(input.generationId);
  const recovery = classifyMigrationRecovery(current);

  // Step 1: classify recovery.
  if (recovery.action === "readback") {
    return recoverPendingPublishRollback(input, deps, store, current, now);
  }
  if (recovery.action === "settled") {
    if (recovery.phase === "rolled-back") {
      return recoverRolledBackAuthority(input, deps, current);
    }
    if (recovery.phase !== "active") {
      throw new RollbackOrchestrationError(
        "unexpected-state",
        `generation ${input.generationId} is settled at phase ${recovery.phase}; no rollback is available on this manifest`,
      );
    }
    // Fresh start from an activated manifest with no pending effect --
    // falls through to the full step 2-12 sequence below, same as a fresh
    // start from "verified".
  } else if (recovery.action === "ready" && current.phase === "rolling-back") {
    // prepare-rollback already completed on a prior attempt and sealed
    // rollbackLineage.returnPhase; classifyMigrationRecovery returns
    // "ready" here (not "resume") because there is no pending effect.
    // Re-beginning prepare-rollback would be illegal (legalEffect only
    // accepts it from "verified"/"active"). Continue from step 9.
    return continueAfterPrepareRollback(input, deps, store, current, now);
  }
  // recovery.action === "ready" (phase "verified") or "resume" (a pending
  // prepare-rollback, retry-idempotent) both fall through: "resume"
  // re-derives the identical deterministic inputSha256 below and the
  // begin-effect call becomes a no-op comparison rather than a fresh
  // begin, per section 8's convergence rule.

  // Boundary C's operability fact MUST be read before enterMaintenance
  // (step 2 below), never after -- see readBackendPublicationOperabilityFact's
  // own doc comment on why. Boundary A's witness resolution is read
  // alongside it so both observations describe the same instant.
  // donadiosolutions/lcm#1432: resolveRollbackOperabilityFact (rather
  // than the bare live reader) so a RETRY of this same fresh/resume path
  // -- reached after a crash anywhere from here through step 8, where
  // enterMaintenance has already run and archived the live slot -- falls
  // back to the durable rollback-authority artifact instead of observing
  // "unresolvable" and refusing permanently.
  assertCoveredProjectIsSoleRemoteBinding(deps, input);
  const { fact: operabilityFact, artifact: priorAuthorityArtifact } = await resolveRollbackOperabilityFact({
    homeDir: input.homeDir,
    generationId: input.generationId,
  });
  // An unresolvable operability fact refuses whatever the other readers say
  // (resolveActivationAuthority's first row); refusing here as well narrows
  // the type, so the authority artifact below can never be written with it.
  if (operabilityFact.state === "unresolvable") {
    throw new RollbackOrchestrationError("not-eligible", "operability-fact:unresolvable: " + operabilityFact.reason);
  }
  const witnessResolution = deps.resolveWitnessBindings({
    homeDir: input.homeDir,
    generationId: input.generationId,
  });
  const evidence = deps.resolveActivationEvidence({
    homeDir: input.homeDir,
    generationId: input.generationId,
  });
  const authority = resolveActivationAuthority({ resolution: witnessResolution, evidence, operabilityFact });
  if (authority.status === "refused") {
    throw new RollbackOrchestrationError("not-eligible", authority.reason);
  }
  // A generation that was never activated has no activation records to unwind and PostgreSQL was never the
  // published backend, so there is nothing to roll back from: the operator restores the configuration or runs
  // lcm migration abort. Refused before the authority artifact, maintenance or the manifest are touched.
  if (authority.status === "unactivated") {
    throw new RollbackOrchestrationError(
      "not-eligible",
      "this generation never completed an activation (no activation selection is bound), so there is nothing to "
        + "roll back from; restore the configuration to sqlite or run lcm migration abort",
    );
  }
  assertAuthorityAgreesWithArtifact(authority, priorAuthorityArtifact);

  const authoritativeContext = await deps.resolveAuthoritativeContext({
    homeDir: input.homeDir,
    generationId: input.generationId,
    epochId: authority.selection.epochId,
    attemptId: authority.selection.attemptId,
    witnessChecksumSha256: authority.selection.witnessChecksumSha256,
  });
  if (authoritativeContext === null) {
    throw new RollbackOrchestrationError(
      "unexpected-state",
      "authoritative selection resolved but its epoch/attempt record could not be fetched",
    );
  }

  // donadiosolutions/lcm#1432: persist the durable rollback-authority
  // artifact BEFORE entering maintenance (step 2) -- see this artifact's
  // own module doc comment for why it must live here rather than between
  // steps 7 and 8. Idempotent: a retry regenerates byte-identical
  // content (operabilityFact/authority above are unchanged from any
  // prior write for this generationId, per the cross-check just above).
  //
  // Plan-v3.1 A8: the activation's retained publication is read here, before
  // anything of this rollback can archive it, and only its identities and
  // digests are persisted. A retry reads the persisted copy back instead.
  const artifact = priorAuthorityArtifact ?? writeRollbackAuthorityArtifact(input.homeDir, {
    version: 2,
    generationId: input.generationId,
    operabilityFactState: operabilityFact.state,
    operabilityFactValueSha256: operabilityFact.state === "present" ? operabilityFact.valueSha256 : null,
    epochId: authority.selection.epochId,
    attemptId: authority.selection.attemptId,
    publication: resolveRollbackPublicationSource(deps, input, authority.selection),
  });

  return withBackendPublicationAppendBarrierAsync(input.homeDir, async (token) => {
    let working = current;

    // Step 2: enterMaintenance under the retained token.
    //
    // donadiosolutions/lcm#1432 (closing the same window from the other
    // side). enterMaintenance refuses ("unresolved-publication") when a
    // non-terminal maintenance journal already exists -- it only
    // idempotently resumes its OWN "maintenance-entering" sub-phase, per
    // its own doc comment and coordinator-seam-FROZEN.md section 3. A
    // crash anywhere from here through step 8 leaves maintenance durably
    // "maintenance-held", so a fresh retry that always calls
    // enterMaintenance again -- as this line did before -- fails on
    // exactly the crash window the durable rollback-authority artifact
    // above was introduced to recover, for a DIFFERENT reason than the
    // operability-fact one: not an unresolvable fact, but a coordinator
    // refusal to re-enter a maintenance it (correctly) does not know is
    // this SAME attempt's own. This file does not own backend-publication.ts
    // and cannot teach enterMaintenance a new idempotent-resume branch,
    // so the check is made here instead: if a held maintenance journal
    // already matches every field THIS call would have supplied, it is
    // adopted as-is rather than re-entered. A mismatch on any field (a
    // genuinely different or unrelated maintenance) is deliberately left
    // to enterMaintenance's own call below, which refuses loudly rather
    // than this function guessing whose maintenance it is.
    const publicationId = deriveRollbackPublicationId(input.generationId);
    const existingMaintenance = readBackendMaintenanceJournal(input.homeDir);
    const maintenanceJournal = maintenanceAlreadyHeldForThisAttempt(existingMaintenance, {
      publicationId,
      generationId: input.generationId,
      sourceBackend: "postgresql",
      sourceSelectionSha256: input.sourceSelectionSha256,
      queueEvidenceSha256: input.queueEvidenceSha256,
      roster: input.roster,
    })
      ? existingMaintenance!
      : await deps.coordinator.enterMaintenance({
        publicationId,
        generationId: input.generationId,
        // A rollback's window starts from PostgreSQL: an abort (a refused readback, an abandoned recovery)
        // leaves PostgreSQL selected for consumers and replay admission (PR #1556 thread 4307516130).
        sourceBackend: "postgresql",
        sourceSelectionSha256: input.sourceSelectionSha256,
        queueEvidenceSha256: input.queueEvidenceSha256,
        roster: input.roster,
        now: now(),
      }, token);

    // Step 3: acquire the fenced PostgreSQL session (Boundary F).
    const session = await deps.openFencedSession({
      homeDir: input.homeDir, manifest: working, lockToken: token,
      scratchParent: input.scratchParent, signal: input.signal,
    });
    return withFencedSession(session, async () => {
      // Step 4: authoritative readback in the dedicated snapshot.
      const observation = await session.captureReadback({
        canonicalDeltaBaseline: authoritativeContext.attempt.canonicalDeltaBaseline,
      });

      // Steps 5+6 combined: identity gate, schema-bound census
      // comparability, and classification, in that order -- exactly the
      // order evaluateRollbackEligibility already implements.
      const decision = evaluateRollbackEligibility({
        authoritativeContext,
        observation,
      });
      if (decision.eligibility === "refused") {
        await deps.coordinator.abortMaintenance({
          expectedChecksumSha256: maintenanceJournal.checksumSha256,
          sourceSelectionSha256: input.sourceSelectionSha256,
          abortEvidenceSha256: sha256(canonicalJson(["rollback-abort-v1", input.generationId, decision.reason])),
        }, token);
        throw new RollbackOrchestrationError("not-eligible", decision.reason);
      }

     // Step 7: begin prepare-rollback with a deterministic inputSha256.
     const epochIdForInput = authority.selection.epochId;
      // donadiosolutions/lcm#1432, a third independent defect found while
      // building the resume tests this fix requires: on a "resume"
      // (classifyMigrationRecovery's retry-idempotent action, reached
      // when a crashed prior attempt's begin already landed durably),
      // "working" here is the manifest AFTER that begin -- one revision
      // past the "verified"/"active" state the crashed attempt actually
      // computed prepareInputSha256 from. Recomputing from working.revision
      // /working.checksumSha256 unconditionally therefore used the WRONG
      // baseline on every resume and could never match the stored
      // pendingEffect.inputSha256, making every resume of a pending
      // prepare-rollback refuse permanently below -- unreachable via any
      // committed test before this continuation added one. The correct
      // baseline is one revision back, which working.previousManifestSha256
      // already names exactly (it is the checksum of the immediate
      // predecessor manifest, i.e. the pre-begin state) whenever a pending
      // effect exists.
      const prepareInputBaselineRevision = working.pendingEffect === null ? working.revision : working.revision - 1;
      const prepareInputBaselineChecksumSha256 = working.pendingEffect === null
        ? working.checksumSha256
        : working.previousManifestSha256!;
      const prepareInputSha256 = deriveRollbackPrepareInputSha256({
        generationId: input.generationId,
        manifestRevision: prepareInputBaselineRevision,
        manifestChecksumSha256: prepareInputBaselineChecksumSha256,
        epochId: epochIdForInput,
        resourceType: session.selectionAuthority.resourceType,
        resourceKey: session.selectionAuthority.resourceKey,
      });
      const prepareEffectId = "rollback-prepare-" + prepareInputSha256;
      if (working.pendingEffect === null) {
        working = publishManifest(store, input.generationId, working, beginMigrationEffect(working, {
          effectId: prepareEffectId,
          kind: "prepare-rollback",
          inputSha256: prepareInputSha256,
          startedAt: now().toISOString(),
        }));
      } else if (
        working.pendingEffect.kind !== "prepare-rollback"
        || working.pendingEffect.inputSha256 !== prepareInputSha256
      ) {
        throw new RollbackOrchestrationError(
          "unexpected-state",
          "a pending effect exists that does not match this rollback attempt's deterministic input",
        );
      }

      // Step 8: complete prepare-rollback; returnPhase seals.
      working = publishManifest(store, input.generationId, working, completeMigrationEffect(working, {
        effectId: working.pendingEffect!.effectId,
        completedAt: now().toISOString(),
      }));

      return runPostPrepareSequence(
        input, deps, store, working, session, authority, authoritativeContext, artifact, decision, token, now,
      );
    });
  });
}



function requireMaintenanceChecksum(homeDir: string): string {
  const journal = readBackendMaintenanceJournal(homeDir);
  if (journal === null) {
    throw new RollbackOrchestrationError("unexpected-state", "backend maintenance journal is unexpectedly absent");
  }
  return journal.checksumSha256;
}

function rollbackGenerationBuildRoot(homeDir: string): string {
  return join(resolve(homeDir), ".lcm", "migration-rollback-generations");
}

const ROLLBACK_GENERATION_BUILD_ATTEMPT_ORDINAL_PATTERN = /^[1-9][0-9]*$/u;
/** The bounded scan of the build root (#1550 C6: shared with the set rollback, unchanged). */
export const MAX_ROLLBACK_GENERATION_BUILD_ATTEMPT_ENTRIES = 100_000;
/** The generation-id limit the manifest store and the rollback generation builder both enforce. */
const MAX_GENERATION_ID_LENGTH = 128;
/**
 * The longest suffix a build id appends to its base: "-rb" + revision + "-" + ordinal, each a safe integer of at
 * most 16 digits. Reserving it keeps the base form independent of the revision and ordinal actually in use, so
 * the ordinal lookup's prefix and every attempt's id agree for a given base whatever its attempt number is.
 */
const ROLLBACK_GENERATION_BUILD_SUFFIX_RESERVE = "-rb".length + 16 + "-".length + 16;
const ROLLBACK_GENERATION_BUILD_BASE_BUDGET = MAX_GENERATION_ID_LENGTH - ROLLBACK_GENERATION_BUILD_SUFFIX_RESERVE;
const ROLLBACK_GENERATION_BUILD_BASE_DIGEST_LENGTH = 32;

/**
 * The base a post-write rollback's generation ids are derived from (`<base>-rb<revision>-<ordinal>`). A generation
 * id may itself be the full 128 characters the stores allow, so appending the suffix verbatim could exceed the
 * limit the builder enforces and fail every build. A base within the budget is used unchanged; a longer one is
 * bounded deterministically to its leading characters plus a 128-bit digest of the whole id, which stays within
 * the generation-id character set and lets a retry after a crash find the earlier attempts of the same base.
 * The bounding is not injective: its 92-character output is itself a legal base that is used unchanged, so a
 * crafted id equal to another id's bounded form shares that id's build prefix and ordinal space. The builder
 * refuses an existing directory (generation-exists) rather than adopting or overwriting it, so such an alias
 * fails closed.
 */
/** @internal Exported for direct unit testing only; not part of the module's public surface. */
export function rollbackGenerationBuildBase(baseGenerationId: string): string {
  if (baseGenerationId.length <= ROLLBACK_GENERATION_BUILD_BASE_BUDGET) return baseGenerationId;
  const head = baseGenerationId.slice(0, ROLLBACK_GENERATION_BUILD_BASE_BUDGET - 1 - ROLLBACK_GENERATION_BUILD_BASE_DIGEST_LENGTH);
  return head + "-" + sha256(baseGenerationId).slice(0, ROLLBACK_GENERATION_BUILD_BASE_DIGEST_LENGTH);
}

/**
 * donadiosolutions/lcm#626 (post-write build retry). Three-valued, like
 * every other resolver in this file: the private root directory not
 * existing yet is a legitimate, positively-determined "no attempt has
 * EVER built here" -- it is created lazily by buildRollbackGeneration's
 * own first call, for any generationId -- not a read failure. Any OTHER
 * failure to open, authenticate or list it REFUSES rather than
 * defaulting to "none found", because a silent default here could mint
 * a build target that collides with an existing quarantined failed
 * generation, the one artifact this item treats as immutable evidence.
 *
 * The match against baseGenerationId/revision is EXACT, never startsWith:
 * the prefix carries its own trailing "-" separator, and the remainder
 * after stripping it must be a bare positive integer with nothing else,
 * so a differently-shaped generationId that happens to share a textual
 * prefix (including one containing "-rb" itself) can never be mistaken
 * for one of THIS generationId/revision pair's own attempts.
 *
 * Exported unchanged for the set rollback (#1550 C6), which allocates its members' fresh physical attempts
 * through this same bounded enumeration and build base.
 */
export function highestRollbackGenerationBuildAttempt(
  homeDir: string,
  baseGenerationId: string,
  revision: number,
  maxEntries: number,
): number {
  const root = rollbackGenerationBuildRoot(homeDir);
  try {
    // The whole body -- including opening the directory -- is inside
    // this one try/catch, deliberately: an EACCES (or any other) failure
    // opening the private directory must be wrapped in the SAME
    // distinguishable message as a failure listing it, so a caller (and
    // a test) can tell this guard fired rather than some other nearby
    // code throwing an incidental, differently-shaped error.
    const handle = openPrivateDirectoryIfExists(root);
    if (handle === undefined) return 0;
    try {
      const prefix = rollbackGenerationBuildBase(baseGenerationId) + "-rb" + revision.toString(10) + "-";
      const directory = opendirSync(root, { bufferSize: 1 });
      let highest = 0;
      try {
        let seen = 0;
        for (;;) {
          const entry = directory.readSync();
          if (entry === null) break;
          seen += 1;
          if (seen > maxEntries) {
            throw new RollbackOrchestrationError(
              "unexpected-state",
              "rollback generation build root has more entries than this enumeration will scan; refusing rather than risk an undercounted ordinal",
            );
          }
          if (!entry.name.startsWith(prefix)) continue;
          const remainder = entry.name.slice(prefix.length);
          if (!ROLLBACK_GENERATION_BUILD_ATTEMPT_ORDINAL_PATTERN.test(remainder)) continue;
          const ordinal = Number(remainder);
          if (Number.isSafeInteger(ordinal) && ordinal > highest) highest = ordinal;
        }
      } finally {
        directory.closeSync();
      }
      return highest;
    } finally {
      handle.close();
    }
  } catch (error) {
    if (error instanceof RollbackOrchestrationError) throw error;
    throw new RollbackOrchestrationError(
      "unexpected-state",
      "could not enumerate existing rollback generation build attempts: " + describeUnresolvable(error),
    );
  }
}

/**
 * Why the fresh step-10 snapshot does not reproduce the export snapshot's
 * evidence, or null when it does. Only reached for a post-write rollback,
 * whose step 10 always captures the census; evaluateRollbackEligibility
 * has already refused an authoritative observation without a delta.
 */
function describeExportDrift(
  exported: Pick<RollbackExportSource, "canonicalDelta" | "censusVector">,
  revalidated: RollbackEligibilityObservation,
): string | null {
  if (migrationCanonicalDeltaChanged(exported.canonicalDelta, revalidated.postEpochDelta!)) {
    return "the destination changed between the export snapshot and revalidation (canonical delta differs)";
  }
  if (revalidated.postEpochCensus === null || !migrationCensusVectorsEqual(exported.censusVector, revalidated.postEpochCensus)) {
    return "the destination changed between the export snapshot and revalidation (census differs)";
  }
  return null;
}

/**
 * Steps 9-12, shared by the fresh path (called from runMigrationRollback
 * right after step 8 completes, inside the same retained token and the
 * same fenced session opened at step 3) and the resumed path (called from
 * continueAfterPrepareRollback under a freshly acquired token and a
 * freshly opened session, when a prior attempt completed prepare-rollback
 * and then crashed before step 9). `decision` is step 9's own input in
 * the fresh path; in the resumed path the caller has no valid step-4
 * observation to reuse (it lived in a dead process) and passes a decision
 * derived from a readback taken at resume time instead. Either way, this
 * function performs its OWN fresh step-10 revalidation before installing,
 * so a resumed run is never less safe than a fresh one -- it is simply
 * the case where steps "9's decision" and "10's decision" are taken from

 * two readbacks that are closer together in time than the fresh path's.
 */
async function runPostPrepareSequence(
  input: Readonly<RunMigrationRollbackInput>,
  deps: Readonly<ResolvedRollbackDependencies>,
  store: MigrationManifestStore,
  working: MigrationManifest,
  session: RollbackFencedSession,
  authority: AuthoritativeActivation,
  authoritativeContext: RollbackAuthoritativeContext,
  artifact: RollbackAuthorityArtifactBody,
  decision: Exclude<RollbackEligibilityDecision, Readonly<{ eligibility: "refused" }>>,
  token: BackendPublicationLockToken,
  now: () => Date,
  /** Set to true once the generation is installed: from then on a refusal is not a contradiction (F6). */
  progress: { installed: boolean } = { installed: false },
): Promise<RunMigrationRollbackOutcome> {
  const mode = decision.mode;

  // Step 9: build, verify -- post-write only. Corrected by this item's
  // continuation: plan-v2 section 1's eligibility table records "Data
  // movement: none" for "pre-write", because
  // nothing was ever durably written past
  // activation -- the live SQLite database at input.canonicalPath is
  // still the correct, current image. Building a reconstruction and
  // installing it over that live database would replace a correct
  // database with a reconstruction, which issue #626's acceptance
  // ("an exact selection reversal with no data copy") and this table
  // both forbid; the predecessor's blanket "not-implemented" refusal for
  // every non-post-write mode was itself the defect this continuation
  // corrects, not a conservative placeholder to keep. Sidecars
  // materialize only after install, once a generation's canonical bytes
  // are final, so they are skipped identically for pre-write: whatever
  // sidecars already sit beside the live database are untouched by this
  // rollback, exactly like the database itself.
  let built: Extract<RollbackGenerationOutcome, Readonly<{ state: "verified" }>> | null = null;
  // Plan-v3.1 amendment A6. The census and canonical delta of the export
  // snapshot the generation is built from; step 10's fresh snapshot must
  // reproduce both exactly. Kept in the build record (the generation's
  // witness.json) rather than the rollback authority artifact: that
  // artifact is written once per generationId before maintenance is
  // entered, long before any export snapshot exists, while a build record
  // is per attempt and written atomically with the build it describes. A
  // crash between steps 9 and 10 resumes with a fresh build from a fresh
  // snapshot, so the comparison never needs to cross a process boundary.
  let exportEvidence: Pick<RollbackExportSource, "canonicalDelta" | "censusVector"> | null = null;
  if (mode === "post-write") {
    const exported = await session.openPortableSource();
    const source = exported.stream;
    exportEvidence = { canonicalDelta: exported.canonicalDelta, censusVector: exported.censusVector };
    // The build target must be a FRESH physical generation per attempt,
    // never reused: plan-v2 section 4's "Resumability, stated honestly"
    // requires "crash recovery creates a new generation under the
    // already-sealed prepare-rollback", with the incomplete one
    // "quarantined read-only at 0400, never deleted" -- and
    // rollback-generation.ts's own SCOPE NOTE refuses ("generation-
    // exists") rather than accept a second build at one path, pushing
    // the mint-or-retry decision up to this orchestration explicitly.
    // The ordinal is derived by enumerating the durable filesystem
    // state rather than threaded through in-memory or manifest state,
    // for the same reason every other identity in this file is: it is
    // compared/derived as a value, attributable evidence rather than an
    // unattributable nonce, and ordered so an operator inspecting
    // quarantined generations reads them in attempt sequence. This does
    // NOT engage contract section 8 (no attempt-time observation in a
    // DETERMINISTIC identity that must converge across retries):
    // section 8 governs identities that must produce the SAME bytes on
    // every retry; this identity must do the opposite, differing per
    // attempt BY CONSTRUCTION, so there is nothing for section 8 to
    // forbid here. buildRollbackGeneration's own "generation-exists"
    // refusal stays as the final guard regardless: even a wrong ordinal
    // fails closed rather than overwriting evidence.
    const buildAttemptOrdinal = highestRollbackGenerationBuildAttempt(
      input.homeDir, input.generationId, working.revision,
      input._maxBuildAttemptEntries ?? MAX_ROLLBACK_GENERATION_BUILD_ATTEMPT_ENTRIES,
    ) + 1;
    const buildOutcome = await buildRollbackGeneration({
      homeDir: input.homeDir,
      generationId: rollbackGenerationBuildBase(input.generationId) + "-rb" + working.revision + "-" + buildAttemptOrdinal,
      projectIdentity: input.projectIdentity,
      source,
      exportEvidence,
      scratchParent: input.scratchParent,
      signal: input.signal,
    });
    if (buildOutcome.state === "quarantined") {
      throw new RollbackOrchestrationError(
        "unexpected-state",
        "rollback generation build failed and was quarantined: " + buildOutcome.reason,
      );
    }
    built = buildOutcome;
  }

  // Step 10: revalidate under a NEW snapshot, never step 4's/9's own.
  await session.renew();
  const revalidated = await session.captureReadback({
    canonicalDeltaBaseline: authoritativeContext.attempt.canonicalDeltaBaseline,
    requireCensus: mode === "post-write",
  });
  const revalidatedDecision = evaluateRollbackEligibility({
    authoritativeContext,
    observation: revalidated,
  });
  if (revalidatedDecision.eligibility === "refused" || revalidatedDecision.mode !== decision.mode) {
    // A racing post-activation write (or any other change) inside the
    // fenced window. working is left at phase "rolling-back" with no
    // pending effect -- a legitimate state a future attempt resumes from
    // via continueAfterPrepareRollback. The generation this attempt built
    // is left in place, verified but unreferenced, never deleted.
    throw new RollbackOrchestrationError(
      revalidatedDecision.eligibility === "refused" ? "not-eligible" : "drift",
      revalidatedDecision.eligibility === "refused"
        ? revalidatedDecision.reason
        : 'revalidation observed mode "' + revalidatedDecision.mode + '" where step 9 acted on "' + decision.mode + '"',
    );
  }

  // A6: a write that landed between the export snapshot and this one can
  // leave the mode at post-write while changing what was exported. Compare
  // the two snapshots' evidence directly rather than inferring from the
  // mode; refuse before anything is installed or selected.
  if (exportEvidence !== null) {
    const drift = describeExportDrift(exportEvidence, revalidated);
    if (drift !== null) throw new RollbackOrchestrationError("drift", drift);
  }

  // #1681: a live passive-event row that genuinely contradicts the verified generation's archive refuses here, with
  // the manifest still resumable at rolling-back, instead of after publish-rollback began and the canonical database
  // was replaced. A resumed publication (pending effect) keeps the post-install verification below.
  if (mode === "post-write" && working.pendingEffect === null) {
    assertRollbackSidecarsCompatible({
      homeDir: input.homeDir,
      databasePath: built!.databasePath,
      localProjectId: input.localProjectId,
      machineId: input.roster[0]!.machineId,
    });
  }

  const epochId = authority.selection.epochId;
  const attemptId = authority.selection.attemptId;
  const terminalEvidenceSha256 = session.computeRollbackTerminalEvidenceSha256({
    epoch: authoritativeContext.epoch,
    attempt: authoritativeContext.attempt,
    observation: revalidated,
    mode: revalidatedDecision.mode,
  });

  // Plan-v3.1 A9 step 1: the rollback witness is minted here from the stored epoch and attempt and must be
  // exactly the evidence the session sealed. It is recorded in the evidence store and bound before anything
  // is selected, so a resume reads it back (its mode included) instead of re-minting it.
  const witness = createMigrationActivationWitness({
    kind: "rollback",
    epoch: authoritativeContext.epoch,
    attempt: authoritativeContext.attempt,
    postEpochDelta: revalidated.postEpochDelta,
    postEpochCensus: revalidated.postEpochCensus,
    rollbackMode: revalidatedDecision.mode,
  });
  if (witness.checksumSha256 !== terminalEvidenceSha256) {
    throw new RollbackOrchestrationError(
      "unexpected-state",
      "the session's terminal evidence is not the rollback witness minted from the same records",
    );
  }
  if (working.pendingEffect === null) {
    deps.recordActivationWitness({ homeDir: input.homeDir, generationId: input.generationId, witness });
    // Section 18: written BEFORE the selection is prepared.
    deps.recordWitnessBinding({
      homeDir: input.homeDir,
      generationId: input.generationId,
      binding: {
        kind: "rollback",
        epochId,
        attemptId,
        manifestRevision: working.revision,
        witnessChecksumSha256: terminalEvidenceSha256,
      },
    });
  }

  // Plan-v3.2 A16a order (supersedes plan-v3.1 A9's): the witness and its
  // binding above, then begin publish-rollback, then install, the
  // maintenance selection, the selection binding, the coordinator's
  // publication, the report, and the effect's completion. The effect is
  // begun first so that every later crash leaves a pending publish-rollback
  // whose input IS the terminal evidence, which recoverPendingPublishRollback
  // resumes from. A resumed publication arrives with the effect already
  // pending and must reproduce its evidence.
  if (working.pendingEffect === null) {
    working = publishManifest(store, input.generationId, working, beginMigrationEffect(working, {
      effectId: "rollback-publish-" + terminalEvidenceSha256,
      kind: "publish-rollback",
      inputSha256: terminalEvidenceSha256,
      startedAt: now().toISOString(),
    }));
  } else if (working.pendingEffect.inputSha256 !== terminalEvidenceSha256) {
    throw new RollbackOrchestrationError(
      "drift",
      "the readback no longer reproduces the pending publish-rollback's terminal evidence",
    );
  }

  // Step 11: install precedes publication -- while PostgreSQL is still
  // the durably selected backend -- then flip maintenance selection to
  // sqlite. Post-write only: pre-write installs nothing
  // and materializes no sidecars, because the live database at
  // input.canonicalPath already IS the correct generation and its
  // existing sidecars are untouched -- see step 9's comment above. The
  // maintenance selection flip immediately below is unconditional: it is
  // the actual "selection reversal" issue #626 asks pre-write to perform.
  if (mode === "post-write") {
    // Step 9 built a verified generation for exactly this mode.
    const installOutcome = installRollbackGeneration({
      homeDir: input.homeDir,
      generationId: built!.generationId,
      rollbackGenerationId: input.generationId,
      canonicalPath: input.canonicalPath,
      verifiedDatabasePath: built!.databasePath,
      syncDirectory: deps.syncDirectory,
    });
    materializeRollbackSidecars({
      homeDir: input.homeDir,
      databasePath: installOutcome.canonicalPath,
      localProjectId: input.localProjectId,
      // The roster is single-machine (the fenced session's activation
      // quiescence check refuses any other) and its machine is this machine;
      // the SQLite surfaces hold only this machine's rows.
      machineId: input.roster[0]!.machineId,
    });
  }
  // Whatever the mode, from here the canonical database is the rollback's (install ran for post-write).
  progress.installed = true;

  // A14: the project map may have changed since the pre-maintenance check.
  const remoteProjectId = assertCoveredProjectIsSoleRemoteBinding(deps, input, token);

  const heldChecksum = requireMaintenanceChecksum(input.homeDir);
  // From the attempt on, nothing may release the lease (F1): the selection may be durable even if the call throws.
  sessionsHoldingLease.add(session);
  const prepared = await deps.coordinator.prepareMaintenanceSelection({
    expectedChecksumSha256: heldChecksum,
    generationId: input.generationId,
    targetBackend: "sqlite",
    terminalEvidenceSha256,
  }, token);
  await deps.coordinator.completeMaintenanceSelection({
    expectedChecksumSha256: prepared.checksumSha256,
    generationId: input.generationId,
    terminalEvidenceSha256,
  }, token);

  return finishRollbackPublication({
    input, deps, store, token, now, artifact, remoteProjectId, epochId, attemptId, terminalEvidenceSha256,
    mode: revalidatedDecision.mode,
    session,
  }, working);
}


/**
 * Resumes a rollback whose prepare-rollback effect already completed
 * (manifest phase "rolling-back", no pending effect) -- classifyMigrationRecovery
 * returns "ready" here, per plan-v2 section 5 step 1: "rolling-back with
 * no pending effect continues to export and publish". This is a fresh
 * process (the original one may have crashed or simply exited after
 * step 8), so it acquires a fresh retained token and a fresh fenced
 * session rather than reusing anything from a prior attempt.
 *
 * donadiosolutions/lcm#1432. This function MUST NOT call
 * readBackendPublicationOperabilityFact directly: the original attempt's
 * own enterMaintenance (step 2) already archived the live publication
 * slot out of view by the time this phase is ever reached, so a live
 * re-read here always observes the still-held maintenance journal and
 * answers "unresolvable". resolveRollbackOperabilityFact recognizes
 * exactly that expected cause and falls back to the durable rollback-
 * authority artifact written before enterMaintenance ever ran; any OTHER
 * unresolvable cause, or a disagreement between a resolvable live read
 * and the artifact, still refuses. Boundary A is read fresh regardless
 * (it is independent of the archived-slot problem) and its resulting
 * authority is required to AGREE with the artifact's recorded
 * epoch/attempt rather than being trusted on its own.
 */
async function resolveContinuationAuthority(
  input: Readonly<RunMigrationRollbackInput>,
  deps: Readonly<ResolvedRollbackDependencies>,
  ownAbortedPublication?: true,
): Promise<Readonly<
  | { status: "refused"; reason: string }
  | {
    status: "resolved";
    authority: AuthoritativeActivation;
    authoritativeContext: RollbackAuthoritativeContext;
    artifact: RollbackAuthorityArtifactBody;
  }
>> {
  const { fact: operabilityFact, artifact: priorAuthorityArtifact } = await resolveRollbackOperabilityFact({
    homeDir: input.homeDir,
    generationId: input.generationId,
    ownAbortedPublication,
  });
  const witnessResolution = deps.resolveWitnessBindings({
    homeDir: input.homeDir,
    generationId: input.generationId,
  });
  const evidence = deps.resolveActivationEvidence({
    homeDir: input.homeDir,
    generationId: input.generationId,
  });
  const authority = resolveActivationAuthority({ resolution: witnessResolution, evidence, operabilityFact });
  if (authority.status === "refused") return { status: "refused", reason: authority.reason };
  if (priorAuthorityArtifact === null) {
    throw new RollbackOrchestrationError(
      "unexpected-state",
      "a rollback is in progress but its durable rollback authority artifact is absent",
    );
  }
  assertAuthorityAgreesWithArtifact(authority, priorAuthorityArtifact);
  const authoritativeContext = await deps.resolveAuthoritativeContext({
    homeDir: input.homeDir,
    generationId: input.generationId,
    epochId: authority.selection.epochId,
    attemptId: authority.selection.attemptId,
    witnessChecksumSha256: authority.selection.witnessChecksumSha256,
  });
  if (authoritativeContext === null) {
    throw new RollbackOrchestrationError(
      "unexpected-state",
      "authoritative selection resolved but its epoch/attempt record could not be fetched",
    );
  }
  return { status: "resolved", authority, authoritativeContext, artifact: priorAuthorityArtifact };
}

/** Sessions whose window reached the maintenance selection: their lease outlives any failure. */
const sessionsHoldingLease = new WeakSet<RollbackFencedSession>();

/**
 * Runs the body with the fenced session and releases it afterwards. A
 * release that fails after a failed body never masks the original failure.
 */
async function withFencedSession<T>(session: RollbackFencedSession, body: () => Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await body();
  } catch (error) {
    // Plan-v3.2 F1: once the maintenance selection was attempted, a failure must not release the lease.
    await (sessionsHoldingLease.has(session) ? session.closeKeepingLease() : session.release()).catch(() => undefined);
    throw error;
  }
  await session.release();
  return result;
}

async function continueAfterPrepareRollback(
  input: Readonly<RunMigrationRollbackInput>,
  deps: Readonly<ResolvedRollbackDependencies>,
  store: MigrationManifestStore,
  current: MigrationManifest,
  now: () => Date,
): Promise<RunMigrationRollbackOutcome> {
  const resolved = await resolveContinuationAuthority(input, deps);
  if (resolved.status === "refused") {
    throw new RollbackOrchestrationError(
      "unexpected-state",
      "continuing a prepared rollback: authority resolution now refuses: " + resolved.reason,
    );
  }
  const { authority, authoritativeContext, artifact } = resolved;

  return withBackendPublicationAppendBarrierAsync(input.homeDir, async (token) => {
    // No enterMaintenance call here: the durable maintenance journal is
    // already held from the original attempt's step 2, and enterMaintenance
    // refuses (unresolved-publication) when a non-terminal maintenance
    // journal already exists. A freshly acquired token still authorizes
    // the coordinator's token branch (coordinator-seam-FROZEN.md section 3:
    // "a consumer-lock token is accepted... does NOT require
    // activeAppendBarrierTokens membership [pre-dating this call]").
    const session = await deps.openFencedSession({
      homeDir: input.homeDir, manifest: current, lockToken: token,
      scratchParent: input.scratchParent, signal: input.signal,
    });
    return withFencedSession(session, async () => {
      const observation = await session.captureReadback({
        canonicalDeltaBaseline: authoritativeContext.attempt.canonicalDeltaBaseline,
      });
      const decision = evaluateRollbackEligibility({
        authoritativeContext,
        observation,
      });
      if (decision.eligibility === "refused") {
        throw new RollbackOrchestrationError("not-eligible", decision.reason);
      }
      return runPostPrepareSequence(
        input, deps, store, current, session, authority, authoritativeContext, artifact, decision, token, now,
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Publication phase (plan-v3.2 A16a, A9): the steps after the maintenance
// selection completes -- the selection binding, the coordinator's
// publication of the sqlite project map and config, the report, and the
// manifest effect's completion. The fresh path, the continuation and every
// resume row of recoverPendingPublishRollback reach it with the same facts.
// ---------------------------------------------------------------------------

type PublicationPhase = Readonly<{
  input: Readonly<RunMigrationRollbackInput>;
  deps: Readonly<ResolvedRollbackDependencies>;
  store: MigrationManifestStore;
  token: BackendPublicationLockToken;
  now: () => Date;
  artifact: RollbackAuthorityArtifactBody;
  /** The covered project's PostgreSQL id, from the project map checked under the token. */
  remoteProjectId: string;
  epochId: string;
  attemptId: string;
  terminalEvidenceSha256: string;
  mode: "pre-write" | "post-write";
  /** Null when no fenced session is open (a resume that starts after the selection). */
  session: RollbackFencedSession | null;
}>;

type PublicationSlot =
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "maintenance"; journal: BackendMaintenanceJournal }>
  | Readonly<{ kind: "publication"; journal: BackendPublicationJournal }>;

/** The one live journal slot holds a maintenance journal or a publication journal, never both. */
function readPublicationSlot(homeDir: string): PublicationSlot {
  const maintenance = readBackendMaintenanceJournal(homeDir);
  if (maintenance !== null) return { kind: "maintenance", journal: maintenance };
  const journal = readBackendPublicationJournal(homeDir);
  return journal === null ? { kind: "empty" } : { kind: "publication", journal };
}

function decodeProjectMapFile(file: BackendPublicationRecoveryFile): ProjectMap | null {
  if (file.presence !== "present") return null;
  try {
    return parseProjectMap(new TextDecoder("utf-8", { fatal: true }).decode(file.content));
  } catch {
    return null;
  }
}

/**
 * Plan-v3.1 A8. The activation's retained publication, read before the
 * rollback's own prepare() can archive it: it must be the publication the
 * activation selection binding names, and it carries the installation as it
 * was before activation. Only identities and digests are kept.
 */
function resolveRollbackPublicationSource(
  deps: Readonly<ResolvedRollbackDependencies>,
  input: Readonly<RunMigrationRollbackInput>,
  selection: MigrationSelectionBinding,
): RollbackPublicationSource {
  const retained = deps.readRetainedMaterial({ homeDir: input.homeDir });
  if (retained.status === "authoritatively-absent") {
    throw new RollbackOrchestrationError(
      "not-eligible",
      "retained-publication-absent: the activation's completed publication is not retained, so there is nothing to restore",
    );
  }
  if (retained.status === "unresolvable") {
    throw new RollbackOrchestrationError(
      "not-eligible",
      "retained-publication-unresolvable: " + retained.reason,
    );
  }
  const { journal, material } = retained;
  if (journal.publicationId !== selection.publicationId || journal.targetBackend !== "postgresql") {
    throw new RollbackOrchestrationError(
      "not-eligible",
      "retained-publication-mismatch: the retained publication is not the activation publication the selection binding names",
    );
  }
  const sourceMap = decodeProjectMapFile(material.source.projectMap);
  const entry = sourceMap?.[input.localProjectId];
  // decodeProjectMapFile yields null -- hence an undefined entry -- unless the project map file is present and
  // decodes, so the entry check already covers an absent or undecodable source map at run time. The presence
  // check is kept only because it narrows the recovery file's type for the digest below (tsc fails without it).
  if (
    entry === undefined
    || material.source.config.presence !== "present"
    || material.source.projectMap.presence !== "present"
  ) {
    throw new RollbackOrchestrationError(
      "not-eligible",
      "retained-publication-source-unusable: the pre-activation config or project map cannot be read for the covered project",
    );
  }
  return {
    publicationId: journal.publicationId,
    sourceBackend: journal.sourceBackend,
    sourceProjectEntry: { localProjectId: input.localProjectId, remoteProjectId: entry.remoteProjectId ?? null },
    sourceConfigSha256: createHash("sha256").update(material.source.config.content).digest("hex"),
    sourceProjectMapSha256: createHash("sha256").update(material.source.projectMap.content).digest("hex"),
  };
}

function expectedRollbackProject(phase: PublicationPhase): Readonly<{
  localProjectId: string;
  remoteProjectId: string;
  evidenceSha256: string;
}> {
  const publicationId = deriveRollbackPublicationId(phase.input.generationId);
  return {
    localProjectId: phase.input.localProjectId,
    remoteProjectId: phase.remoteProjectId,
    evidenceSha256: deriveRollbackProjectEvidenceSha256({
      generationId: phase.input.generationId,
      publicationId,
      localProjectId: phase.input.localProjectId,
      remoteProjectId: phase.remoteProjectId,
    }),
  };
}

function assertComposedPublicationRestoresSource(
  phase: PublicationPhase,
  composed: ReturnType<typeof composeBackendPublicationMaterial>,
): void {
  const source = phase.artifact.publication!;
  const targetMap = decodeProjectMapFile(composed.material.target.projectMap);
  const entry = targetMap?.[phase.input.localProjectId];
  if (
    composed.sourceBackend !== "postgresql"
    || composed.targetBackend !== source.sourceBackend
    || targetMap === null
    || entry === undefined
    || (entry.remoteProjectId ?? null) !== source.sourceProjectEntry.remoteProjectId
    || canonicalJson(composed.projects as unknown as Record<string, unknown>[])
      !== canonicalJson([expectedRollbackProject(phase)] as unknown as Record<string, unknown>[])
  ) {
    throw new RollbackOrchestrationError(
      "unexpected-state",
      "the composed rollback publication does not restore the pre-activation backend and the covered project's pre-activation map entry",
    );
  }
}

/**
 * Whether a coordinator journal under the rollback's publicationId is the publication this rollback composed:
 * postgresql back to the pre-activation backend, for exactly the covered project's pre-activation entry (E4).
 */
function journalIsRollbackComposition(phase: PublicationPhase, journal: BackendPublicationJournal): boolean {
  const project = expectedRollbackProject(phase);
  return journal.sourceBackend === "postgresql"
    && journal.targetBackend === phase.artifact.publication!.sourceBackend
    && journal.projects.length === 1
    && journal.projects[0]!.localProjectId === project.localProjectId
    && journal.projects[0]!.remoteProjectId === project.remoteProjectId
    && journal.projects[0]!.evidenceSha256 === project.evidenceSha256;
}

/**
 * Drives the coordinator's publication of the sqlite config and project map
 * to completion and returns the sealed material digest. Never prepares a
 * second time: a journal for the rollback publicationId already in the live
 * slot is resumed (or, completed, verified) rather than composed again. The
 * exceptions are a journal the coordinator left at preparing without sealed
 * material (E6), which only the coordinator's missing-material abort can
 * settle: it is taken to aborted and the publication is composed and
 * prepared again, under the same barrier and the same fenced session; and
 * an aborted journal that had sealed its material (#1555), composed again
 * only under a recovery session (the caller has proven the restored source
 * and the authority; without a session it refuses).
 */
async function publishRollbackSelection(phase: PublicationPhase): Promise<string> {
  const { input, deps, token } = phase;
  const publicationId = deriveRollbackPublicationId(input.generationId);
  const slot = readPublicationSlot(input.homeDir);
  let journal: BackendPublicationJournal | null = null;
  if (slot.kind === "publication") {
    // Callers reach here with a publication in the slot only after establishing that it is this rollback's.
    // E4: the id alone admitted it; a journal that is not this rollback's composition is refused before anything
    // is resumed (resuming would publish its map and config).
    if (!journalIsRollbackComposition(phase, slot.journal)) {
      throw new RollbackOrchestrationError(
        "unexpected-state",
        "the publication in the live slot carries this rollback's id but is not its composition",
      );
    }
    if (slot.journal.phase === "aborted") {
      // #1555: a journal that had sealed its material was aborted by the coordinator after the publication began,
      // and only recoverPendingPublishRollback's abort row may compose over it (it has proven the source and the
      // authority, and holds a session on the lease). Without a session this is a structural refusal.
      if (slot.journal.recoveryReference !== null && phase.session === null) {
        throw new RollbackOrchestrationError(
          "unexpected-state",
          "the rollback's aborted coordinator publication can only be composed again under a recovery session",
        );
      }
      // E6: the missing-material exit already taken (by an earlier retry that died before preparing again): the
      // journal recorded no fence and published nothing, so it is only the terminal journal prepare() archives.
      journal = null;
    } else {
      journal = slot.journal;
    }
  }
  if (
    journal !== null && journal.phase === "preparing" && journal.recoveryReference === null
    && unsealedPublicationMaterialAbsent(input.homeDir, publicationId)
  ) {
    // E6/E8: prepare() died after the preparing checkpoint and before sealing the material, so there is nothing
    // the coordinator could authenticate (its forward path would only report the file missing). The coordinator's
    // own exit for exactly this state is abort, which takes the unsealed journal straight to aborted (no restore,
    // no fence), after which the publication is composed and prepared again below. Both facts are established
    // positively before the abort: the slot readback above, taken under this barrier with no coordinator call since,
    // is this rollback's own composition at preparing with no reference, and the material is absent at the
    // coordinator's deterministic path. The abort's result is verified to be that unsealed aborted journal. A journal
    // that did seal its material (or any failure inside resume, ENOENT included) never reaches this exit: resume runs
    // below and its failure propagates with the effect pending and the lease held, so a later retry resumes forward.
    const aborted = await deps.coordinator.abort(token);
    if (!isAbortedUnsealedJournal(aborted)) {
      throw new RollbackOrchestrationError(
        "unexpected-state",
        "the rollback's unsealed coordinator publication did not abort as a missing-material publication",
      );
    }
    journal = null;
  }
  if (journal === null) {
    // The caller completed this rollback's maintenance selection (or verified that it had); prepare() archives
    // that terminal journal and refuses any other state of the slot.
    const composed = deps.composePublication({
      homeDir: input.homeDir,
      targetBackend: "sqlite",
      bindings: [expectedRollbackProject(phase)],
    });
    assertComposedPublicationRestoresSource(phase, composed);
    journal = await deps.coordinator.prepare({
      publicationId,
      sourceBackend: composed.sourceBackend,
      targetBackend: composed.targetBackend,
      material: composed.material,
      projects: composed.projects,
    }, token);
  }
  if (journal.phase !== "completed" && journal.phase !== "aborted") {
    // The coordinator acquires the remote fence (adopting the session's lease) and releases it on completion;
    // from here the session verifies instead of releasing.
    phase.session?.markCoordinatorAcquired();
    journal = await deps.coordinator.resume(token);
  }
  if (journal.phase === "aborted") {
    throw new RollbackOrchestrationError("unexpected-state", "the rollback's coordinator publication was aborted");
  }
  if (
    journal.phase !== "completed"
    || journal.publicationId !== publicationId
    || !journalIsRollbackComposition(phase, journal)
    || journal.recoveryReference === null
  ) {
    throw new RollbackOrchestrationError(
      "unexpected-state",
      "the rollback's coordinator publication did not complete as composed",
    );
  }
  return journal.recoveryReference.sealSha256;
}

/**
 * The publication phase proper. working holds the pending publish-rollback
 * effect; the maintenance selection is durably completed.
 */
async function finishRollbackPublication(
  phase: PublicationPhase,
  working: MigrationManifest,
): Promise<RunMigrationRollbackOutcome> {
  const { input, deps, store, now } = phase;
  // Plan-v3.2 A16a: the binding is recorded before the coordinator's prepare(), which archives the maintenance
  // journal that replay admission would otherwise route from. It is rewritten idempotently on every resume.
  deps.recordSelectionBinding({
    homeDir: input.homeDir,
    generationId: input.generationId,
    binding: rollbackSelectionBinding(input.generationId, {
      epochId: phase.epochId,
      attemptId: phase.attemptId,
      manifestRevision: working.revision,
      terminalEvidenceSha256: phase.terminalEvidenceSha256,
    }),
  });
  const sealedDigest = await publishRollbackSelection(phase);

  const effectId = working.pendingEffect!.effectId;
  const reportCreatedAt = now().toISOString();
  const report = writeRollbackReport(input.homeDir, {
    version: 1,
    reportId: deriveRollbackReportId({ generationId: input.generationId, effectId, kind: "rollback" }),
    generationId: input.generationId,
    effectId,
    kind: "rollback",
    eligibility: phase.mode,
    mode: phase.mode,
    epochId: phase.epochId,
    attemptId: phase.attemptId,
    sealedPublicationMaterialDigestSha256: sealedDigest,
    reason: null,
    selectionBindingManifestRevision: working.revision,
  });
  const completed = publishManifest(store, input.generationId, working, completeMigrationEffect(working, {
    effectId,
    completedAt: now().toISOString(),
    report: { kind: "rollback", reportId: report.reportId, reportSha256: report.checksumSha256, createdAt: reportCreatedAt },
    rollbackMode: phase.mode,
  }));
  return { manifest: completed, report };
}

/**
 * Plan-v3.2 A16. A manifest already at rolled-back with no pending effect is
 * settled, but a crash between the selection's completion and the binding
 * write -- or a binding writer that died between link and unlink -- can
 * leave the durable selection binding missing, and replay admission routes
 * from that binding. This entry accepts such a manifest only to complete the
 * missing durable authority: it rewrites the exact binding from the
 * persisted rollback report (which carries the revision the binding was
 * first recorded at), the rollback-authority artifact and the report's
 * effect, through the idempotent recorder (a matching binding is reused). A
 * stored revision that the manifest history contradicts refuses. It never
 * mutates the manifest.
 */
async function recoverRolledBackAuthority(
  input: Readonly<RunMigrationRollbackInput>,
  deps: Readonly<ResolvedRollbackDependencies>,
  current: MigrationManifest,
): Promise<RunMigrationRollbackOutcome> {
  // The protocol only completes publish-rollback with a rollback report.
  const reference = [...current.reports].reverse().find((candidate) => candidate.kind === "rollback")!;
  const report = readRollbackReport(input.homeDir, input.generationId, reference.reportId);
  if (report === null || report.checksumSha256 !== reference.reportSha256) {
    throw new RollbackOrchestrationError(
      "unexpected-state",
      "generation " + input.generationId + " is rolled back but its rollback report cannot be read",
    );
  }
  const artifact = readRollbackAuthorityArtifact(input.homeDir, input.generationId);
  if (artifact === null) {
    throw new RollbackOrchestrationError(
      "unexpected-state",
      "generation " + input.generationId + " is rolled back but its rollback authority artifact is absent",
    );
  }
  const terminalEvidenceSha256 = ROLLBACK_PUBLISH_EFFECT_ID_PATTERN.exec(report.effectId)?.[1];
  if (
    terminalEvidenceSha256 === undefined
    || report.epochId !== artifact.epochId
    || report.attemptId !== artifact.attemptId
  ) {
    throw new RollbackOrchestrationError(
      "unexpected-state",
      "the rollback report does not agree with the rollback authority artifact",
    );
  }
  // The effect completed one revision after it was begun, and the binding was recorded while it was pending:
  // the stored revision must be exactly that, or the report and the manifest history disagree.
  if (report.selectionBindingManifestRevision !== current.revision - 1) {
    throw new RollbackOrchestrationError(
      "unexpected-state",
      "the rollback report's selection binding revision does not match the manifest history",
    );
  }
  return withBackendPublicationAppendBarrierAsync(input.homeDir, async () => {
    deps.recordSelectionBinding({
      homeDir: input.homeDir,
      generationId: input.generationId,
      binding: rollbackSelectionBinding(input.generationId, {
        epochId: artifact.epochId,
        attemptId: artifact.attemptId,
        manifestRevision: report.selectionBindingManifestRevision!,
        terminalEvidenceSha256,
      }),
    });
    return { manifest: current, report };
  });
}

/**
 * The coordinator publication phases at which the rollback's remote fence is still the coordinator's to acquire,
 * adopt or release on its forward path (backend-publication.ts #resumeUnlocked: every one of them advances
 * through #releaseAll). A recovery that meets one of them opens a fenced session on the rollback's lease tuple,
 * which the coordinator adopts (or supersedes, when the row it recorded was already released) and releases. At
 * released the fence is durably released and the coordinator finalizes without another release, and on the abort
 * path it releases whatever it recorded through its own provider: a session lease acquired there would be a fresh
 * row that nothing ever releases, and guarded PostgreSQL writers refuse while any unreleased row exists (E1). The
 * abort path therefore finishes through the coordinator alone and only then opens a session, to resume the
 * publication forward (ABORT_PATH_PUBLICATION_PHASES, #1555).
 */
const FENCE_DRIVING_PUBLICATION_PHASES: readonly BackendPublicationPhase[] = [
  "preparing", "prepared", "acquiring", "guarded", "map-publishing", "map-published",
  "config-publishing", "config-published", "releasing",
];

/**
 * #1555. The coordinator phases of an abort that is under way (backend-publication.ts #abortUnlocked), and the
 * terminal aborted phase once the abort had sealed material to restore from (a reference). A rollback that meets
 * one of them was not the one that aborted: the abort is finished through the coordinator alone and the
 * publication is then resumed forward by composing and preparing it again (recoverExternallyAbortedPublication).
 * An aborted journal without a reference is the missing-material exit instead (E6).
 */
const ABORT_PATH_PUBLICATION_PHASES: readonly BackendPublicationPhase[] = [
  "aborting", "config-restoring", "map-restoring", "abort-releasing",
];

function isExternalAbortJournal(journal: BackendPublicationJournal): boolean {
  return ABORT_PATH_PUBLICATION_PHASES.includes(journal.phase)
    || (journal.phase === "aborted" && journal.recoveryReference !== null);
}

/**
 * Recovers a rollback whose publish-rollback effect was pending when the
 * process died (plan-v3.2 A9 as amended by A16a, and the owner's decisions
 * on S3c). The effect is begun before anything is installed or selected, so
 * its pending input is the rollback's terminal evidence and the durable
 * facts decide where the publication stopped:
 *
 *  - maintenance held: nothing was selected. The publication resumes in
 *    place -- a fresh fenced readback, build and install (idempotent with
 *    readback) -- and must reproduce the pending evidence. It is abandoned
 *    only when that readback is unresolvable or contradicts the artifact or
 *    the pending evidence;
 *  - selection prepared with this generation, sqlite and this evidence: the
 *    selection is completed, then the publication continues;
 *  - selection completed likewise: the publication continues from the
 *    selection binding;
 *  - the live slot holds this rollback's coordinator publication (our own
 *    prepare archived the maintenance journal): the binding was written
 *    before it, so the coordinator is resumed (or, completed, verified)
 *    and the report and the manifest completion follow. A fenced session
 *    is opened only while the coordinator still drives the fence
 *    (FENCE_DRIVING_PUBLICATION_PHASES); at released and at completed it
 *    is resumed without acquiring a lease;
 *  - the slot holds this rollback's publication on the abort path, or
 *    aborted after it sealed its material (#1555: something else aborted
 *    it): the abort is finished through the coordinator alone, the
 *    restored source and the authority are proven again, and the
 *    publication is composed and prepared again under a recovery session
 *    that takes the lease (recoverExternallyAbortedPublication). A refusal
 *    or a drift leaves the effect pending, the slot aborted and the lease
 *    held;
 *  - the slot holds nothing of this rollback and no rollback selection
 *    binding exists: no selection could have completed, so the effect is
 *    abandoned. With a binding the selection did complete and the journal
 *    was archived by someone else, which refuses.
 *
 * An abandonment never assumes a fence: a coordinator publication of this
 * rollback is always resumed, never abandoned (seam section 19).
 */
async function recoverPendingPublishRollback(
  input: Readonly<RunMigrationRollbackInput>,
  deps: Readonly<ResolvedRollbackDependencies>,
  store: MigrationManifestStore,
  current: MigrationManifest,
  now: () => Date,
): Promise<RunMigrationRollbackOutcome> {
  const pending = current.pendingEffect;
  if (pending === null || pending.kind !== "publish-rollback") {
    throw new RollbackOrchestrationError("unexpected-state", "recoverPendingPublishRollback called without a pending publish-rollback effect");
  }
  const artifact = readRollbackAuthorityArtifact(input.homeDir, input.generationId);
  if (artifact === null) {
    throw new RollbackOrchestrationError(
      "unexpected-state",
      "a pending publish-rollback has no rollback authority artifact to finish or abandon it from",
    );
  }
  const terminalEvidenceSha256 = pending.inputSha256;
  const publicationId = deriveRollbackPublicationId(input.generationId);

  return withBackendPublicationAppendBarrierAsync(input.homeDir, async (token) => {
    const slot = readPublicationSlot(input.homeDir);

    /** Everything the publication phase needs when no fenced session is open. */
    const storedPhase = (): PublicationPhase => {
      const remoteProjectId = assertCoveredProjectIsSoleRemoteBinding(deps, input, token);
      // The mode is the stored rollback witness's, never inferred; no witness refuses.
      const evidence = deps.resolveActivationEvidence({ homeDir: input.homeDir, generationId: input.generationId });
      const witness = evidence.state === "resolved"
        ? evidence.witnesses.find((candidate) => candidate.kind === "rollback" && candidate.checksumSha256 === terminalEvidenceSha256)
        : undefined;
      if (witness === undefined) {
        throw new RollbackOrchestrationError(
          "unexpected-state",
          "the pending publish-rollback has no stored rollback witness to take its mode from",
        );
      }
      const mode = witness.rollbackMode!;
      return {
        input, deps, store, token, now, artifact, remoteProjectId,
        epochId: artifact.epochId, attemptId: artifact.attemptId, terminalEvidenceSha256,
        mode, session: null,
      };
    };

    /**
     * Runs a recovery step under a fresh fenced session on the rollback's lease tuple. The selection was already
     * attempted by an earlier process, so no failure here releases the lease.
     */
    const withRecoverySession = async <T,>(body: (session: RollbackFencedSession) => Promise<T>): Promise<T> => {
      const session = await deps.openFencedSession({
        homeDir: input.homeDir, manifest: current, lockToken: token,
        scratchParent: input.scratchParent, signal: input.signal, recovery: true,
      });
      sessionsHoldingLease.add(session);
      return withFencedSession(session, () => body(session));
    };

    /**
     * Whether a rollback selection binding is recorded. Three-valued in effect (F5): an unresolvable binding store
     * establishes nothing -- neither that a selection completed nor that it did not -- so it refuses here, before
     * any report or manifest mutation, rather than reading as "no binding" and abandoning the effect.
     */
    const hasRollbackSelectionBinding = (): boolean => {
      const resolution = deps.resolveWitnessBindings({ homeDir: input.homeDir, generationId: input.generationId });
      if (resolution.state === "unresolvable") {
        throw new MigrationBindingUnresolvableError(
          "the selection bindings cannot be resolved, so whether this rollback's selection completed is unknown: "
            + resolution.reason,
        );
      }
      return resolution.state === "resolved" && resolution.selections.some((selection) => selection.kind === "rollback");
    };

    /**
     * #1555. This rollback's own publication was aborted by something other than this rollback (the coordinator's
     * abort ran, or stopped part-way, after the publication began). The retained barrier is held throughout. In
     * order: (1) the journal must be this rollback's composition, before anything is mutated; (2) an abort that
     * stopped part-way is finished through the coordinator alone (no session: it releases what it recorded through
     * its own provider, and a lease acquired here would be a row nothing releases); (3) the slot must now hold the
     * aborted, referenced journal of the same composition with no fence left unreleased, and the source files it
     * restored must read back as witnessed; (4) a recovery session takes the lease (a successor token when the
     * abort released the recorded one, the original row when the coordinator never acquired it) and every failure
     * from there keeps it; (5) the authority and the readback are proven again, and only then is the publication
     * composed and prepared again over the aborted journal. A drift or a refusal at (5) leaves the effect pending,
     * the slot aborted and the lease held, and every retry refuses the same way.
     */
    const recoverExternallyAbortedPublication = async (
      first: PublicationPhase,
      journal: BackendPublicationJournal,
    ): Promise<RunMigrationRollbackOutcome> => {
      const notComposition = (): RollbackOrchestrationError => new RollbackOrchestrationError(
        "unexpected-state",
        "the publication in the live slot carries this rollback's id but is not its composition",
      );
      if (!journalIsRollbackComposition(first, journal)) throw notComposition();
      if (journal.phase !== "aborted") await deps.coordinator.abort(token);
      const settled = readPublicationSlot(input.homeDir);
      if (
        settled.kind !== "publication"
        || settled.journal.publicationId !== publicationId
        || settled.journal.phase !== "aborted"
        || settled.journal.recoveryReference === null
        || settled.journal.projects.some((project) => project.fence !== null && project.fence.releasedAt === null)
      ) {
        throw new RollbackOrchestrationError(
          "unexpected-state",
          "the rollback's coordinator publication did not settle as an aborted publication with every recorded fence released",
        );
      }
      const phase = storedPhase();
      if (!journalIsRollbackComposition(phase, settled.journal)) throw notComposition();
      return withRecoverySession(async (session) => {
        await revalidatePreparedSelection(input, deps, current, session, phase, true);
        return finishRollbackPublication({ ...phase, session }, current);
      });
    };

    /**
     * Abandons the effect back to the sealed return phase. Only callers that have shown no selection was
     * prepared or completed reach it; an unfinished maintenance of this generation is aborted first.
     */
    const abandon = async (
      reason: string,
      unfinished?: BackendMaintenanceJournal,
    ): Promise<RunMigrationRollbackOutcome> => {
      if (unfinished !== undefined) {
        await deps.coordinator.abortMaintenance({
          expectedChecksumSha256: unfinished.checksumSha256,
          sourceSelectionSha256: input.sourceSelectionSha256,
          abortEvidenceSha256: sha256(canonicalJson(["rollback-recovery-abort-v1", input.generationId, pending.effectId])),
        }, token);
      }
      const report = writeRollbackReport(input.homeDir, {
        version: 1,
        reportId: deriveRollbackReportId({ generationId: input.generationId, effectId: pending.effectId, kind: "abandonment" }),
        generationId: input.generationId,
        effectId: pending.effectId,
        kind: "abandonment",
        eligibility: null,
        mode: null,
        epochId: null,
        attemptId: null,
        sealedPublicationMaterialDigestSha256: null,
        reason: "publish-rollback recovery could not prove the selection completed: " + reason,
        selectionBindingManifestRevision: null,
      });
      const reportCreatedAt = now().toISOString();
      const abandoned = publishManifest(store, input.generationId, current, abandonMigrationEffect(current, {
        effectId: pending.effectId,
        abandonedAt: now().toISOString(),
        report: { kind: "abandonment", reportId: report.reportId, reportSha256: report.checksumSha256, createdAt: reportCreatedAt },
      }));
      return { manifest: abandoned, report };
    };

    if (slot.kind === "maintenance" && slot.journal.generationId === input.generationId) {
      const maintenance = slot.journal;
      if (maintenance.phase === "maintenance-held") {
        const resumed = await resumeHeldPublication(input, deps, store, current, artifact, token, now);
        return resumed.status === "completed" ? resumed.outcome : abandon(resumed.reason, maintenance);
      }
      if (maintenance.phase === "selection-prepared" || maintenance.phase === "selection-completed") {
        if (maintenance.targetBackend !== "sqlite" || maintenance.terminalEvidenceSha256 !== terminalEvidenceSha256) {
          throw new RollbackOrchestrationError(
            "not-implemented",
            "publish-rollback must be abandoned but the maintenance journal is already durably "
              + maintenance.phase + " for a different or ambiguous target; re-selecting postgresql "
              + "requires a mechanism this item has not implemented -- see this item's status report",
          );
        }
        const phase = storedPhase();
        // F1: the lease may have expired or been lost since the process that prepared the selection died, so a
        // fresh fenced session on the same tuple is opened (it takes over our own expired lease and refuses a
        // lease held by anyone else). A prepared selection is revalidated against it before it is completed;
        // a completed one is final.
        return withRecoverySession(async (session) => {
          if (maintenance.phase === "selection-prepared") {
            await revalidatePreparedSelection(input, deps, current, session, phase);
            await deps.coordinator.completeMaintenanceSelection({
              expectedChecksumSha256: maintenance.checksumSha256,
              generationId: input.generationId,
              terminalEvidenceSha256,
            }, token);
          }
          return finishRollbackPublication({ ...phase, session }, current);
        });
      }
      // The only other phase a pending effect can meet is maintenance-aborted: no selection was ever prepared.
      return abandon("the maintenance was " + maintenance.phase);
    }
    if (slot.kind === "publication" && slot.journal.publicationId === publicationId) {
      if (!hasRollbackSelectionBinding()) {
        throw new RollbackOrchestrationError(
          "unexpected-state",
          "this rollback's coordinator publication is in the live slot without the selection binding that must precede it",
        );
      }
      const phase = storedPhase();
      // #1555: this rollback's publication is on the abort path or was aborted after it sealed its material
      // (something other than this rollback ran the coordinator's abort). It is resumed forward by re-running the
      // rollback once the abort is finished, the source is proven restored and the authority is proven again.
      if (isExternalAbortJournal(slot.journal)) return recoverExternallyAbortedPublication(phase, slot.journal);
      // E6: an aborted journal that never sealed its material is the coordinator's missing-material exit; the
      // publication is composed and prepared again under a recovery session, exactly as a selection-completed
      // maintenance would be.
      if (FENCE_DRIVING_PUBLICATION_PHASES.includes(slot.journal.phase) || isAbortedUnsealedJournal(slot.journal)) {
        return withRecoverySession((session) => finishRollbackPublication({ ...phase, session }, current));
      }
      // Released: the coordinator recorded the authoritative post-release readback of every fence when it got
      // here, and resuming it only finalizes. Settling over a journal that says otherwise would report
      // rolled-back with a fence this rollback acquired still unreleased, so it refuses instead.
      if (
        slot.journal.phase === "released"
        && slot.journal.projects.some((project) => project.fence === null || project.fence.releasedAt === null)
      ) {
        throw new RollbackOrchestrationError(
          "unexpected-state",
          "the rollback's coordinator publication is released but does not record a released fence for every project",
        );
      }
      return finishRollbackPublication(phase, current);
    }
    if (hasRollbackSelectionBinding()) {
      throw new RollbackOrchestrationError(
        "unexpected-state",
        "the rollback selection completed but its maintenance journal was archived by another publication",
      );
    }
    return abandon("no journal of this rollback remains");
  });
}

/**
 * F1. A prepared maintenance selection is completed only if a fresh fenced readback still reproduces the terminal
 * evidence the pending effect carries: the same authority, the same mode and, through the rollback witness, the
 * same delta and census the export and step 10 saw. A contradiction cannot abort a prepared selection (the
 * coordinator has no such exit), so it is refused with a typed error and everything is left as it is.
 */
async function revalidatePreparedSelection(
  input: Readonly<RunMigrationRollbackInput>,
  deps: Readonly<ResolvedRollbackDependencies>,
  current: MigrationManifest,
  session: RollbackFencedSession,
  phase: PublicationPhase,
  ownAbortedPublication?: true,
): Promise<void> {
  const resolved = await resolveContinuationAuthority(input, deps, ownAbortedPublication);
  if (resolved.status === "refused") {
    throw new RollbackOrchestrationError("not-eligible", "the authority no longer resolves: " + resolved.reason);
  }
  const { authoritativeContext } = resolved;
  const observation = await session.captureReadback({
    canonicalDeltaBaseline: authoritativeContext.attempt.canonicalDeltaBaseline,
    requireCensus: phase.mode === "post-write",
  });
  const decision = evaluateRollbackEligibility({ authoritativeContext, observation });
  if (decision.eligibility === "refused") throw new RollbackOrchestrationError("not-eligible", decision.reason);
  const evidence = session.computeRollbackTerminalEvidenceSha256({
    epoch: authoritativeContext.epoch,
    attempt: authoritativeContext.attempt,
    observation,
    mode: decision.mode,
  });
  if (decision.mode !== phase.mode || evidence !== phase.terminalEvidenceSha256) {
    throw new RollbackOrchestrationError(
      "drift",
      "the destination no longer reproduces the pending publish-rollback's terminal evidence; the prepared selection is not completed",
    );
  }
}

/**
 * The maintenance is held and the effect pending: nothing was selected. Reopens
 * the fenced session and runs the publication again from the readback; the
 * readback must reproduce the pending effect's terminal evidence. A refusal
 * or a drift is a contradiction (the caller abandons); any other failure
 * propagates and leaves the pending effect for the next attempt.
 */
async function resumeHeldPublication(
  input: Readonly<RunMigrationRollbackInput>,
  deps: Readonly<ResolvedRollbackDependencies>,
  store: MigrationManifestStore,
  current: MigrationManifest,
  artifact: RollbackAuthorityArtifactBody,
  token: BackendPublicationLockToken,
  now: () => Date,
): Promise<Readonly<{ status: "completed"; outcome: RunMigrationRollbackOutcome } | { status: "contradicted"; reason: string }>> {
  const resolved = await resolveContinuationAuthority(input, deps);
  if (resolved.status === "refused") {
    return { status: "contradicted", reason: "the authority no longer resolves: " + resolved.reason };
  }
  const { authority, authoritativeContext } = resolved;
  const progress = { installed: false };
  const session = await deps.openFencedSession({
    homeDir: input.homeDir, manifest: current, lockToken: token,
    scratchParent: input.scratchParent, signal: input.signal,
  });
  try {
    const outcome = await withFencedSession(session, async () => {
      const observation = await session.captureReadback({
        canonicalDeltaBaseline: authoritativeContext.attempt.canonicalDeltaBaseline,
      });
      const decision = evaluateRollbackEligibility({ authoritativeContext, observation });
      if (decision.eligibility === "refused") {
        throw new RollbackOrchestrationError("not-eligible", decision.reason);
      }
      return runPostPrepareSequence(
        input, deps, store, current, session, authority, authoritativeContext, artifact, decision, token, now, progress,
      );
    });
    return { status: "completed", outcome };
  } catch (error) {
    // Only a refusal before the install is a contradiction of the pending effect. After it the canonical
    // database was replaced, so a refusal (a transient second binding, say) propagates and leaves the effect
    // pending, exactly as on the fresh path (F6).
    if (
      !progress.installed
      && error instanceof RollbackOrchestrationError
      && (error.reason === "not-eligible" || error.reason === "drift")
    ) {
      return { status: "contradicted", reason: error.message };
    }
    throw error;
  }
}
