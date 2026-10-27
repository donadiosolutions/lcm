import { configPath } from "../runtime-paths.js";
import { MachineIdentityFileError, requireMachineIdentity } from "../machine-identity.js";
import type { StorageIdentityContext } from "../storage/contracts.js";
import { connectionSettings } from "../storage/postgresql/factory.js";
import type { PostgreSqlConnectionSettings } from "../storage/postgresql/contracts.js";
import { resolveMigrationExpectedIdentity } from "./cli-preflight.js";
import { resolveMigrationTargetConfig } from "./target-config.js";

/**
 * The one destination resolution the existing-generation commands that talk
 * to PostgreSQL share (plan-v6.1 B1, A-P1-1): fresh `verify` (row 22) and
 * `activate`. It never mints anything and never writes:
 *
 * - `settings` is `connectionSettings(...)` around the resolved
 *   `storage.postgresql` object, the transfer-role connection verify opens
 *   and activate keeps as `transferSettings`. After its dry-run branch,
 *   cli-activate separately resolves the daemon role from the activate-only
 *   `LCM_POSTGRES_RUNTIME_URL` and passes that as `ordinarySettings`. Neither
 *   secret is written to `config.json`.
 * - `expectedOwner` is the resolved `migrationRole`.
 * - `expectedIdentity` is the held-safe identity (the persisted local map
 *   entry plus a SELECT of the destination alias); it is the same
 *   `StorageIdentityContext` `resume`'s destination cells use.
 *
 * Each of the three is read from an existing resolution. A value that cannot
 * be resolved is a refusal, never a substitute.
 */

export type MigrationDestinationResolution =
  | Readonly<{
    status: "resolved";
    settings: PostgreSqlConnectionSettings;
    expectedOwner: string;
    expectedIdentity: StorageIdentityContext;
  }>
  | Readonly<{ status: "refuse"; reason: string; evidence?: string }>;

export type MigrationDestinationOperations = Readonly<{
  resolveTargetConfig: typeof resolveMigrationTargetConfig;
  requireMachine: typeof requireMachineIdentity;
  resolveIdentity: typeof resolveMigrationExpectedIdentity;
}>;

export async function resolveMigrationDestination(input: Readonly<{
  cwd: string;
  homeDir: string;
  /** @internal Deterministic failure-injection seam for tests only. */
  _operationsForTesting?: Partial<MigrationDestinationOperations>;
}>): Promise<MigrationDestinationResolution> {
  const resolveTargetConfig = input._operationsForTesting?.resolveTargetConfig ?? resolveMigrationTargetConfig;
  const requireMachine = input._operationsForTesting?.requireMachine ?? requireMachineIdentity;
  const resolveIdentity = input._operationsForTesting?.resolveIdentity ?? resolveMigrationExpectedIdentity;

  const target = resolveTargetConfig(configPath(input.homeDir));
  if (target.status === "refuse") {
    return { status: "refuse", reason: target.reason, ...(target.evidence === undefined ? {} : { evidence: target.evidence }) };
  }
  let machineId: string;
  try {
    machineId = requireMachine(input.homeDir).machineId;
  } catch (error) {
    if (error instanceof MachineIdentityFileError) return { status: "refuse", reason: "machine-identity-unregistered" };
    throw error;
  }
  const identity = await resolveIdentity({
    preflight: { targetConfig: target.config, machineId, candidate: { disposition: "continue-held" } },
    cwd: input.cwd,
    homeDir: input.homeDir,
  });
  if (identity.status === "refuse") {
    return { status: "refuse", reason: identity.reason, ...(identity.evidence === undefined ? {} : { evidence: identity.evidence }) };
  }
  return {
    status: "resolved",
    settings: connectionSettings(target.config),
    expectedOwner: target.config.postgresql.migrationRole,
    expectedIdentity: identity.expectedIdentity,
  };
}
