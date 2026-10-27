import { readDaemonConfigSnapshot, type StorageBackend } from "../daemon/config.js";
import { configPath, daemonPidPath } from "../runtime-paths.js";
import { checkActivationRestartAdmission, type ActivationRestartCheckResult } from "./activation-restart-check.js";
import { combineMigrationRestart } from "./cli-restart.js";
import { classifyMigrationDaemonPresence, type MigrationDaemonPresence } from "./daemon-presence.js";
import { unexpectedFailureEvidence } from "./boundary.js";
import type { MigrationEnvelopeRestart, MigrationEvidence } from "./envelope.js";
import type { MigrationManifestStore } from "./manifest-store.js";

/**
 * What `activate` and `rollback` (the two cutover commands) share: one
 * outcome type, the restart observation, and the manifest-revision check
 * that says whether a thrown error left a durable write behind.
 */

export type MigrationCutoverCommandOutcome =
  | Readonly<{
    status: "ok";
    generationId: string;
    manifestPhase: string | null;
    applied: boolean;
    next: string | null;
    evidence: MigrationEvidence;
    restart?: MigrationEnvelopeRestart | null;
  }>
  | Readonly<{
    status: "refuse";
    reason: string;
    /** A closed detail marker (an error name or a state), never a message. */
    evidence?: string;
    generationId?: string;
    next?: string | null;
    /** True only when a durable write preceded this refusal. */
    applied?: true;
    /** Everything the command read or was told before it refused. */
    sections?: MigrationEvidence;
    restart?: MigrationEnvelopeRestart | null;
  }>;

export const CUTOVER_RESTART_REASONS = Object.freeze({
  required: "cutover-restart-required",
  contradiction: "cutover-restart-contradiction",
  unresolvable: "cutover-restart-unresolvable",
});

export type MigrationCutoverRestartOperations = Readonly<{
  checkRestart: typeof checkActivationRestartAdmission;
  classifyPresence: typeof classifyMigrationDaemonPresence;
  readDaemonPort: (homeDir: string) => number;
}>;

export type CutoverRestartOutcome = Readonly<{
  /** Absent when the plan-v4 section 7 cell is satisfied (exit 0 may proceed). */
  reason?: string;
  restart: MigrationEnvelopeRestart | null;
  evidence: MigrationEvidence;
}>;

/**
 * Combines a restart verdict the owning verifier already produced with a
 * fresh daemon-presence observation, by the matrix `report` applies (plan-v4
 * section 7). A presence that cannot be observed fails closed.
 */
export async function combineCutoverRestart(args: Readonly<{
  homeDir: string;
  verdict: ActivationRestartCheckResult;
  selected: StorageBackend;
  classifyPresence?: typeof classifyMigrationDaemonPresence | undefined;
}>): Promise<CutoverRestartOutcome> {
  let presence: MigrationDaemonPresence;
  try {
    presence = await (args.classifyPresence ?? classifyMigrationDaemonPresence)({ homeDir: args.homeDir });
  } catch (error) {
    return {
      reason: CUTOVER_RESTART_REASONS.unresolvable, restart: null,
      evidence: { selectedBackend: args.selected, restartObservation: unexpectedFailureEvidence(error) },
    };
  }
  const combined = combineMigrationRestart(args.verdict, presence, args.selected);
  return {
    ...(combined.class === "ok" ? {} : { reason: CUTOVER_RESTART_REASONS[combined.class] }),
    restart: combined.restart,
    evidence: combined.evidence,
  };
}

/** The same observation when the verdict has to be asked for too (rollback has none of its own). */
export async function observeCutoverRestart(args: Readonly<{
  homeDir: string;
  selected: StorageBackend;
  operations?: Partial<MigrationCutoverRestartOperations>;
}>): Promise<CutoverRestartOutcome> {
  const checkRestart = args.operations?.checkRestart ?? checkActivationRestartAdmission;
  const readDaemonPort = args.operations?.readDaemonPort
    ?? ((home: string) => readDaemonConfigSnapshot(configPath(home)).config.daemon.port);
  let verdict: ActivationRestartCheckResult;
  try {
    verdict = await checkRestart({
      selectedBackend: args.selected, pidFilePath: daemonPidPath(args.homeDir), port: readDaemonPort(args.homeDir),
    });
  } catch (error) {
    return {
      reason: CUTOVER_RESTART_REASONS.unresolvable, restart: null,
      evidence: { selectedBackend: args.selected, restartObservation: unexpectedFailureEvidence(error) },
    };
  }
  return combineCutoverRestart({
    homeDir: args.homeDir, verdict, selected: args.selected, classifyPresence: args.operations?.classifyPresence,
  });
}

/**
 * Whether the manifest moved since `revisionBefore`. An unreadable manifest
 * counts as moved: after an error, a refusal must not claim that nothing was
 * written unless that was positively read back.
 */
export function manifestMovedSince(store: MigrationManifestStore, generationId: string, revisionBefore: number): boolean {
  try {
    return store.read(generationId).revision !== revisionBefore;
  } catch {
    return true;
  }
}
