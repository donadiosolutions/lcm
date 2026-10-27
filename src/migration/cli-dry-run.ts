import {
  dryRunAuthenticatedSqliteMigrationSource,
} from "./maintenance.js";
import { SqliteSnapshotError, type SqliteSnapshotDryRun } from "./sqlite-snapshot.js";

/**
 * Section 3's `dry-run` command: owns exactly
 * `dryRunAuthenticatedSqliteMigrationSource` and nothing else. No
 * generation resolution, no occupancy probe, no journal read, and no
 * PostgreSQL target -- a read-only check of the SQLite source alone, per
 * the owner's explicit correction against making this symmetrical with
 * `plan`.
 */

export type MigrationDryRunOutcome =
  | Readonly<{ status: "ok"; dryRun: SqliteSnapshotDryRun }>
  | Readonly<{ status: "refuse"; reason: string; evidence?: string }>;

export type MigrationDryRunOperations = Readonly<{
  dryRun: typeof dryRunAuthenticatedSqliteMigrationSource;
}>;

export async function performMigrationDryRunCheck(input: Readonly<{
  cwd: string;
  homeDir: string;
  /**
   * @internal Deterministic failure-injection seam for tests only, matching
   * the `_operationsForTesting` convention used elsewhere in
   * `src/migration/`.
   */
  _operationsForTesting?: Partial<MigrationDryRunOperations>;
}>): Promise<MigrationDryRunOutcome> {
  const dryRun = input._operationsForTesting?.dryRun ?? dryRunAuthenticatedSqliteMigrationSource;
  try {
    const result = await dryRun(input.cwd, input.homeDir);
    return { status: "ok", dryRun: result };
  } catch (error) {
    if (error instanceof SqliteSnapshotError) {
      return { status: "refuse", reason: "dry-run-failed", evidence: error.reason };
    }
    return {
      status: "refuse",
      reason: "dry-run-failed",
      evidence: error instanceof Error ? error.name : "unknown-dry-run-failure",
    };
  }
}

/**
 * The flat, envelope-shaped evidence for a successful dry-run. Never the
 * raw `SqliteSnapshotDryRun` object: its `roles` field is a nested array,
 * which does not fit section 10's flat, closed evidence record, so it is
 * summarized to a count rather than spread in.
 */
export function migrationDryRunEvidence(dryRun: SqliteSnapshotDryRun): Readonly<Record<string, string | number>> {
  return {
    sourceSelectionSha256: dryRun.sourceSelectionSha256,
    sourceByteWitnessSha256: dryRun.sourceByteWitnessSha256,
    checksumSha256: dryRun.checksumSha256,
    roleCount: dryRun.roles.length,
    inspectedAt: dryRun.inspectedAt,
  };
}
