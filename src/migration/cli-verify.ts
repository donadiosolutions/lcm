import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateMutationLockContentionError } from "../private-mutation-lock.js";
import { withBackendPublicationAppendBarrierAsync } from "../storage/backend-publication.js";
import { MigrationManifestStore } from "./manifest-store.js";
import { MigrationProtocolError, type MigrationManifest } from "./protocol.js";
import {
  completePendingMigrationVerification,
  inspectMigrationVerification,
  MigrationVerificationDriverError,
  verifyMigrationGeneration,
  type VerifyMigrationGenerationInput,
} from "./verify-generation.js";
import { MigrationVerificationReportStore, MigrationVerificationStoreError } from "./verification-store.js";
import { parseMigrationQueueClassificationWitness } from "./verification-report.js";
import { migrationWitnessSha256 } from "./activation-witness.js";
import { migrationCopyTargetGeneration } from "./copy-source.js";
import { computeMigrationProjectMapWitnessSha256, MigrationProjectMapWitnessError } from "./project-map-witness.js";
import { inspectAuthenticatedSqliteMigrationSnapshot } from "./queue-evidence.js";
import { resolveMigrationDestination } from "./cli-destination.js";
import { MIGRATION_UNEXPECTED_FAILURE_REASON, withMigrationBoundary } from "./boundary.js";
import {
  admitExistingMigrationCommand,
  refuseUnlessConfirmed,
} from "./cli-existing.js";
import type { MigrationEvidence } from "./envelope.js";
import type { ExistingGenerationInput } from "./existing-generation.js";
import type { StorageIdentityContext } from "../storage/contracts.js";
import type { PostgreSqlConnectionSettings } from "../storage/postgresql/contracts.js";

/**
 * The `verify` command's CLI orchestration (plan-v4 section 5 as amended by
 * plan-v5 Part B (2)). It owns two router cells and borrows a third:
 *
 * - **Row 23** (pending `verify-generation`): `completePendingMigrationVerification`,
 *   the persisted-report shortcut `verifyMigrationGeneration` has always had.
 *   It needs no destination, project map, lease or identity, so it works with
 *   PostgreSQL down. Exit 0 requires the read-back below, never the call's own
 *   return value.
 * - **Row 24** (already `verified`, nothing pending; `verify` is allowed there
 *   by owner ruling R9): an idempotent confirmation from persisted evidence.
 *   Nothing is written.
 * - **Row 22** (`copied`, nothing pending): the fresh computation
 *   (plan-v4 section 5). Every input of `VerifyMigrationGenerationInput` is
 *   read from an existing source and none is invented: the destination
 *   settings, owner and identity from `resolveMigrationDestination`; the
 *   sealed destination digests and system identifier from the manifest; the
 *   queue-classification witness from the authenticated snapshot's receipt
 *   reference; and #625's `computeMigrationProjectMapWitnessSha256`
 *   (`pre-publication`) for the project-map witness. Only this path opens
 *   PostgreSQL. It takes #624's verification lease and the source append
 *   barrier, which the envelope's `coordinationEffects` states, and
 *   `--dry-run` runs the same computation through
 *   `inspectMigrationVerification` and persists nothing.
 *
 * Owner check, then the `--confirm-generation` fence, then the first read of
 * persisted evidence; each reads only, so a refusal leaves durable state
 * byte-identical.
 */

export type MigrationVerifyCommandOutcome =
  | Readonly<{
    status: "ok";
    generationId: string;
    manifestPhase: string;
    applied: boolean;
    /** The command to run next, or null when nothing in this build follows. */
    next: string | null;
    evidence: MigrationEvidence;
  }>
  | Readonly<{
    status: "refuse";
    reason: string;
    evidence?: string;
    generationId?: string;
    next?: string | null;
    /** True only when a durable write preceded this refusal. */
    applied?: true;
  }>;

export type VerifyRefusal = Extract<MigrationVerifyCommandOutcome, { status: "refuse" }>;

export type MigrationVerifyCommandOperations = Readonly<{
  completePending: typeof completePendingMigrationVerification;
  admit: typeof admitExistingMigrationCommand;
  resolveDestination: typeof resolveMigrationDestination;
  inspectSnapshot: typeof inspectAuthenticatedSqliteMigrationSnapshot;
  computeProjectMapWitness: typeof computeMigrationProjectMapWitnessSha256;
  verify: typeof verifyMigrationGeneration;
  inspect: typeof inspectMigrationVerification;
  mintOwnerProcessId: () => string;
}>;

export type MigrationVerifyCommandInput = Readonly<{
  cwd: string;
  homeDir: string;
  generation?: string;
  confirmGenerationId?: string;
  dryRun?: boolean;
  leaseTtlMs?: number;
  manifestStore?: MigrationManifestStore;
  reportStore?: MigrationVerificationReportStore;
  /** @internal Test-only seam into the generation resolver. */
  _resolution?: Pick<ExistingGenerationInput, "_operationsForTesting">;
  /** @internal Deterministic failure-injection seam for tests only. */
  _operationsForTesting?: Partial<MigrationVerifyCommandOperations>;
}>;

export function performMigrationVerifyCommand(input: MigrationVerifyCommandInput): Promise<MigrationVerifyCommandOutcome> {
  return withMigrationBoundary(
    () => runMigrationVerifyCommand(input),
    // An unclassified throw cannot rule out that the completion had been written.
    (evidence) => ({ status: "refuse", reason: MIGRATION_UNEXPECTED_FAILURE_REASON, evidence, applied: true }),
  );
}

/** The verification driver's typed reasons that row 23 can reach, mapped to the closed table. */
const DRIVER_REASONS: ReadonlySet<string> = new Set(["report-identity-conflict", "destination-drift", "invalid-input"]);

function persistedEvidenceRefusal(generationId: string, reason: string, evidence: string): VerifyRefusal {
  return { status: "refuse", reason, evidence, generationId };
}

/**
 * Reads the manifest and its verification report back and requires them to
 * agree: phase `verified`, nothing pending, the last verification report
 * reference naming a persisted report that is activation-eligible. Returns the
 * evidence for an ok outcome or a refusal.
 */
export function readVerifiedEvidence(
  generationId: string,
  manifestStore: MigrationManifestStore,
  reportStore: MigrationVerificationReportStore,
  expectedReportSha256: string | null,
): Readonly<{ status: "verified"; evidence: MigrationEvidence }> | VerifyRefusal {
  try {
    const manifest = manifestStore.read(generationId);
    const reference = [...manifest.reports].reverse().find((report) => report.kind === "verification");
    if (manifest.phase !== "verified" || manifest.pendingEffect !== null || reference === undefined) {
      return persistedEvidenceRefusal(generationId, "verify-readback-mismatch", `manifest-${manifest.phase}`);
    }
    const report = reportStore.read(generationId, reference.reportSha256);
    if (!report.activationEligible) {
      return persistedEvidenceRefusal(generationId, "verify-readback-mismatch", "report-not-eligible");
    }
    if (reference.reportSha256 !== report.reportSha256
      || reference.reportId !== report.reportId
      || (expectedReportSha256 !== null && expectedReportSha256 !== report.reportSha256)) {
      return persistedEvidenceRefusal(generationId, "verify-readback-mismatch", "report-reference-mismatch");
    }
    return {
      status: "verified",
      evidence: {
        reportId: report.reportId,
        reportSha256: report.reportSha256,
        activationEligible: report.activationEligible,
      },
    };
  } catch (error) {
    if (error instanceof MigrationProtocolError) {
      return persistedEvidenceRefusal(generationId, "manifest-unresolvable", `manifest-${error.reason}`);
    }
    if (error instanceof MigrationVerificationStoreError) {
      return persistedEvidenceRefusal(generationId, "verify-report-unresolvable", `report-${error.reason}`);
    }
    throw error;
  }
}

/**
 * Router row 23, shared by `verify` (its own cell) and `resume` (which is
 * allowed there): finish the pending verify-generation effect from persisted
 * evidence and read the result back before reporting it.
 */
export function completePendingVerificationCell(input: Readonly<{
  homeDir: string;
  generationId: string;
  manifestStore: MigrationManifestStore;
  reportStore: MigrationVerificationReportStore;
  completePending: typeof completePendingMigrationVerification;
}>): MigrationVerifyCommandOutcome {
  const { generationId } = input;
  let completed;
  try {
    completed = input.completePending({ homeDir: input.homeDir, generationId });
  } catch (error) {
    if (error instanceof MigrationVerificationDriverError && DRIVER_REASONS.has(error.reason)) {
      return { status: "refuse", reason: `verify-${error.reason}`, generationId };
    }
    if (error instanceof MigrationProtocolError) {
      return persistedEvidenceRefusal(generationId, "manifest-unresolvable", `manifest-${error.reason}`);
    }
    if (error instanceof MigrationVerificationStoreError) {
      return persistedEvidenceRefusal(generationId, "verify-report-unresolvable", `report-${error.reason}`);
    }
    throw error;
  }
  if (completed === null) {
    // The router saw a pending verify-generation effect a moment ago and
    // the driver does not: the manifest moved underneath this command.
    return persistedEvidenceRefusal(generationId, "verify-readback-mismatch", "pending-effect-moved");
  }
  const confirmed = readVerifiedEvidence(generationId, input.manifestStore, input.reportStore, completed.report.reportSha256);
  if (confirmed.status !== "verified") return { ...confirmed, applied: true };
  return {
    status: "ok", generationId, manifestPhase: "verified", applied: true, next: "activate",
    evidence: { ...confirmed.evidence, cell: 23, coordinationEffects: "none" },
  };
}

/** The verification lease's default time to live (plan-v4 section 5). */
export const DEFAULT_MIGRATION_VERIFY_LEASE_TTL_MS = 300_000;

const VERIFY_COORDINATION_EFFECTS = "verification-lease,source-append-barrier";

function verifyRefusal(generationId: string, reason: string, evidence?: string): VerifyRefusal {
  return { status: "refuse", reason, generationId, ...(evidence === undefined ? {} : { evidence }) };
}

export type FreshInputsResult =
  | Readonly<{ status: "ready"; input: Omit<VerifyMigrationGenerationInput, "scratchParent"> }>
  | VerifyRefusal;

/**
 * Builds every input of the fresh computation from existing sources (see the
 * module comment). A source that cannot be read is a closed refusal; nothing
 * is written and PostgreSQL is contacted only to SELECT the destination alias.
 */
async function buildFreshInputs(args: Readonly<{
  input: MigrationVerifyCommandInput;
  generationId: string;
  manifest: MigrationManifest;
  ops: Partial<MigrationVerifyCommandOperations> | undefined;
}>): Promise<FreshInputsResult> {
  const { input, generationId, manifest, ops } = args;
  // A manifest written before the copy recorded the cluster identifier cannot
  // be verified, and no identifier is invented in its place.
  if (manifest.destination.systemIdentifier === undefined) return verifyRefusal(generationId, "verify-destination-drift", "system-identifier-absent");
  const destination = await (ops?.resolveDestination ?? resolveMigrationDestination)({ cwd: input.cwd, homeDir: input.homeDir });
  if (destination.status === "refuse") return verifyRefusal(generationId, destination.reason, destination.evidence);
  return buildVerificationInputs({
    homeDir: input.homeDir, generationId, manifest, destination,
    ...(input.leaseTtlMs === undefined ? {} : { leaseTtlMs: input.leaseTtlMs }), ops,
  });
}

/**
 * Every input of the fresh computation that follows the destination
 * resolution, shared with the cutover-set preparation (#1548 C7), which
 * supplies one member's destination from its already resolved target instead
 * of rereading the disk configuration. Nothing here writes; PostgreSQL is not
 * contacted.
 */
export async function buildVerificationInputs(args: Readonly<{
  homeDir: string;
  generationId: string;
  manifest: MigrationManifest;
  destination: Readonly<{
    settings: PostgreSqlConnectionSettings;
    expectedOwner: string;
    expectedIdentity: StorageIdentityContext;
  }>;
  leaseTtlMs?: number;
  ops: Partial<MigrationVerifyCommandOperations> | undefined;
}>): Promise<FreshInputsResult> {
  const { homeDir, generationId, manifest, destination, ops } = args;
  const refuse = (reason: string, evidence?: string): VerifyRefusal => verifyRefusal(generationId, reason, evidence);

  const expectedSystemIdentifier = manifest.destination.systemIdentifier;
  if (expectedSystemIdentifier === undefined) return refuse("verify-destination-drift", "system-identifier-absent");

  const { expectedIdentity } = destination;
  const { localProjectId, remoteProjectId } = expectedIdentity;
  // A resolved identity always names its local project; this guards the type, not a reachable state.
  if (localProjectId === undefined || remoteProjectId === undefined) {
    return refuse("verify-invalid-input", "identity-incomplete");
  }

  let receipt;
  try {
    receipt = (await (ops?.inspectSnapshot ?? inspectAuthenticatedSqliteMigrationSnapshot)(generationId, homeDir)).receiptReference;
  } catch {
    return refuse("snapshot-unresolvable");
  }
  // The five-field projection of the authenticated receipt reference (the thirteen-field form does not parse).
  const queueClassificationWitness = parseMigrationQueueClassificationWitness({
    version: 1,
    queueCutoff: receipt.queueCutoff,
    queueSetSha256: receipt.queueSetSha256,
    receiptSetSha256: receipt.receiptSetSha256,
    epochChecksumSha256: receipt.epochChecksumSha256,
  });

  let projectMapWitnessSha256: string;
  try {
    // Under a maintenance hold the project map is read under the source append barrier's token,
    // exactly as the activation reads the same witness; without it the consumer lock is fenced.
    projectMapWitnessSha256 = await withBackendPublicationAppendBarrierAsync(homeDir, (token) =>
      (ops?.computeProjectMapWitness ?? computeMigrationProjectMapWitnessSha256)({
        homeDir,
        localProjectId,
        remoteProjectId,
        mode: "pre-publication",
        publicationLockToken: token,
      }));
  } catch (error) {
    if (error instanceof PrivateMutationLockContentionError) return refuse("verify-contention");
    if (error instanceof MigrationProjectMapWitnessError) {
      return refuse(error.reason === "project-map-drift" ? "verify-project-map-drift"
        : error.reason === "project-map-unresolvable" ? "verify-project-map-unresolvable" : "verify-invalid-input");
    }
    throw error;
  }

  return {
    status: "ready",
    input: {
      generationId,
      targetGenerationId: migrationCopyTargetGeneration(generationId),
      homeDir,
      expectedIdentity,
      destinationSettings: destination.settings,
      expectedOwner: destination.expectedOwner,
      ownerProcessId: (ops?.mintOwnerProcessId ?? randomUUID)(),
      leaseTtlMs: args.leaseTtlMs ?? DEFAULT_MIGRATION_VERIFY_LEASE_TTL_MS,
      manifestRevision: manifest.revision,
      manifestChecksumSha256: manifest.checksumSha256,
      destinationMigrationsSha256: manifest.destination.schemaSha256,
      expectedDestinationIdentitySha256: manifest.destination.identitySha256,
      expectedSystemIdentifier,
      projectMapWitnessSha256,
      queueClassificationWitness,
      sampleParameters: {
        version: 1,
        strideOrdinal: 1,
        sampleCount: 0,
        seedBasisSha256: migrationWitnessSha256(["lcm-migration-verify-seed-v1", generationId, manifest.destination.identitySha256]),
      },
    },
  };
}

/** Failures that can only precede the first durable write of the fresh computation. */
const PRE_WRITE_FAILURES: ReadonlySet<string> = new Set(["verify-contention", "verify-invalid-input", "verify-destination-drift"]);

/**
 * A typed failure of the fresh computation, mapped to the closed table, or
 * `null` for anything else (which escapes to the boundary: exit 5).
 * `mayHaveWritten` is false for the dry run, which persists nothing; for a
 * real run only the pre-write reasons are known to leave the home unchanged.
 */
function freshFailure(generationId: string, error: unknown, mayHaveWritten: boolean): VerifyRefusal | null {
  let reason: string;
  let evidence: string | undefined;
  if (error instanceof PrivateMutationLockContentionError) {
    reason = "verify-contention";
  } else if (error instanceof MigrationVerificationDriverError) {
    reason = error.reason === "lease-unavailable" || error.reason === "lease-lost" ? "verify-contention" : `verify-${error.reason}`;
  } else if (error instanceof MigrationProtocolError) {
    reason = "manifest-unresolvable";
    evidence = `manifest-${error.reason}`;
  } else if (error instanceof MigrationVerificationStoreError) {
    reason = "verify-report-unresolvable";
    evidence = `report-${error.reason}`;
  } else {
    return null;
  }
  return {
    status: "refuse", reason, generationId,
    ...(evidence === undefined ? {} : { evidence }),
    ...(mayHaveWritten && !PRE_WRITE_FAILURES.has(reason) ? { applied: true as const } : {}),
  };
}

async function runFreshVerification(args: Readonly<{
  input: MigrationVerifyCommandInput;
  generationId: string;
  manifest: MigrationManifest;
  manifestStore: MigrationManifestStore;
  reportStore: MigrationVerificationReportStore;
  ops: Partial<MigrationVerifyCommandOperations> | undefined;
}>): Promise<MigrationVerifyCommandOutcome> {
  const { input, generationId, manifest, manifestStore, reportStore, ops } = args;
  const dryRun = input.dryRun === true;
  const inputs = await buildFreshInputs({ input, generationId, manifest, ops });
  if (inputs.status === "refuse") return inputs;

  const scratchParent = mkdtempSync(join(tmpdir(), "lcm-migration-verify-"));
  try {
    if (dryRun) {
      let report;
      try {
        report = await (ops?.inspect ?? inspectMigrationVerification)({ ...inputs.input, scratchParent });
      } catch (error) {
        const mapped = freshFailure(generationId, error, false);
        if (mapped === null) throw error;
        return mapped;
      }
      if (!report.activationEligible) {
        return { status: "refuse", reason: "verify-not-eligible", generationId, evidence: report.clean ? "coverage-incomplete" : "mismatches" };
      }
      return {
        status: "ok", generationId, manifestPhase: manifest.phase, applied: false, next: "verify (drop --dry-run to record it)",
        evidence: {
          reportId: report.reportId, reportSha256: report.reportSha256, activationEligible: true,
          cell: 22, wouldBe: "clean", coordinationEffects: VERIFY_COORDINATION_EFFECTS,
        },
      };
    }

    let result;
    try {
      result = await (ops?.verify ?? verifyMigrationGeneration)({ ...inputs.input, scratchParent });
    } catch (error) {
      const mapped = freshFailure(generationId, error, true);
      if (mapped === null) throw error;
      return mapped;
    }
    if (!result.report.activationEligible) {
      // The report is persisted as operator evidence; the manifest stays copied.
      return {
        status: "refuse", reason: "verify-not-eligible", generationId, applied: true,
        evidence: result.report.clean ? "coverage-incomplete" : "mismatches",
      };
    }
    const confirmed = readVerifiedEvidence(generationId, manifestStore, reportStore, result.report.reportSha256);
    if (confirmed.status !== "verified") return { ...confirmed, applied: true };
    return {
      status: "ok", generationId, manifestPhase: "verified", applied: true, next: "activate",
      evidence: { ...confirmed.evidence, cell: 22, coordinationEffects: VERIFY_COORDINATION_EFFECTS },
    };
  } finally {
    rmSync(scratchParent, { recursive: true, force: true });
  }
}

async function runMigrationVerifyCommand(input: MigrationVerifyCommandInput): Promise<MigrationVerifyCommandOutcome> {
  const completePending = input._operationsForTesting?.completePending ?? completePendingMigrationVerification;
  const admit = input._operationsForTesting?.admit ?? admitExistingMigrationCommand;
  const manifestStore = input.manifestStore ?? new MigrationManifestStore({ homeDir: input.homeDir });
  const reportStore = input.reportStore ?? new MigrationVerificationReportStore({ homeDir: input.homeDir });

  const admission = await admit({
    command: "verify",
    homeDir: input.homeDir,
    ...(input.generation === undefined ? {} : { generation: input.generation }),
    resolution: { manifestStore, ...input._resolution },
  });
  if (admission.status === "refuse") return admission;
  const { context } = admission;
  const generationId = context.generationId;

  const unconfirmed = refuseUnlessConfirmed({ expectedGenerationId: generationId, confirmGenerationId: input.confirmGenerationId });
  if (unconfirmed !== null) return unconfirmed;

  switch (context.route.row) {
    case 22:
      return runFreshVerification({
        input, generationId, manifest: context.manifest!, manifestStore, reportStore, ops: input._operationsForTesting,
      });

    case 24: {
      const confirmed = readVerifiedEvidence(generationId, manifestStore, reportStore, null);
      if (confirmed.status !== "verified") return confirmed;
      return {
        status: "ok", generationId, manifestPhase: "verified", applied: false, next: "activate",
        evidence: { ...confirmed.evidence, cell: 24, coordinationEffects: "none" },
      };
    }

    case 23: {
      if (input.dryRun === true) {
        // Route-only: completing the pending effect writes the manifest, and
        // the checks it makes cannot be run without that write. Nothing here
        // is predicted, which the evidence says.
        return {
          status: "ok", generationId, manifestPhase: context.manifest!.phase, applied: false,
          next: "verify (drop --dry-run to complete)",
          evidence: { cell: 23, predictive: false, pendingEffect: "verify-generation", coordinationEffects: "none" },
        };
      }
      return completePendingVerificationCell({ homeDir: input.homeDir, generationId, manifestStore, reportStore, completePending });
    }

    default:
      // The router admitted `verify` only at rows 22 to 24. Anything else is a
      // defect in the router or here, never a state to guess about.
      throw new Error(`verify was admitted at an unexpected router row`);
  }
}

