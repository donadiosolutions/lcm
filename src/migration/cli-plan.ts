import {
  migrationIdentityPreview,
  resolveMigrationPreflight,
  type MigrationIdentityPreview,
  type MigrationPreflightResult,
} from "./cli-preflight.js";
import { MIGRATION_UNEXPECTED_FAILURE_REASON, withMigrationBoundary } from "./boundary.js";
import type { MigrationDaemonPresence } from "./daemon-presence.js";

/**
 * The `plan` command's CLI orchestration (section 3): entirely
 * non-mutating. Runs the shared preflight and reports its result --
 * candidate generation id, disposition, and the positively-established
 * daemon presence -- without ever taking the hold, capturing, or writing
 * anything. Section 9's genesis repair depends on this: `apply
 * --confirm-generation <id>` must be able to compare against exactly the
 * id `plan` printed, which is why this function calls the same
 * `resolveMigrationPreflight` `apply`'s own preflight uses rather than a
 * second implementation of the same resolution.
 */

export type MigrationPlanOutcome =
  | Readonly<{
    status: "ok";
    generationId: string;
    disposition: string;
    /**
     * The shared preflight's own daemon-presence classification, carried
     * through unchanged rather than flattened. Both `present` (with its
     * observed backend, which may disagree with the live config -- that
     * disagreement is #1384's condition and a finding, not noise) and
     * `authoritatively-absent` reach this point; `unresolvable` refuses
     * upstream in the shared preflight and never reaches here.
     */
    daemonPresence: Extract<MigrationDaemonPresence, { status: "present" } | { status: "authoritatively-absent" }>;
    /** What apply would mint, reported without minting it (plan-v5 Part B (3)). */
    identityPreview: MigrationIdentityPreview;
  }>
  | Readonly<{ status: "refuse"; reason: string; evidence?: string }>;

export type MigrationPlanInput = Readonly<{
  cwd: string;
  homeDir: string;
  /**
   * @internal Test-only escape hatch to reuse resolveMigrationPreflight's
   * own injection seam without duplicating its composition here.
   */
  _preflight?: () => Promise<MigrationPreflightResult>;
}>;

export function performMigrationPlan(input: MigrationPlanInput): Promise<MigrationPlanOutcome> {
  return withMigrationBoundary(
    () => runMigrationPlan(input),
    (evidence) => ({ status: "refuse", reason: MIGRATION_UNEXPECTED_FAILURE_REASON, evidence }),
  );
}

async function runMigrationPlan(input: MigrationPlanInput): Promise<MigrationPlanOutcome> {
  const runPreflight = input._preflight ?? (() => resolveMigrationPreflight({ cwd: input.cwd, homeDir: input.homeDir }));
  const preflight = await runPreflight();
  if (preflight.status === "refuse") {
    return preflight;
  }
  return {
    status: "ok",
    generationId: preflight.candidate.generationId,
    disposition: preflight.candidate.disposition,
    daemonPresence: preflight.presence,
    identityPreview: migrationIdentityPreview(preflight),
  };
}
