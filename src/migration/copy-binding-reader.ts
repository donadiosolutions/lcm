import { normalizeUuidV7 } from "../machine-identity.js";
import { StorageOperationError } from "../storage/errors.js";
import type { PostgreSqlQueryExecutor } from "../storage/postgresql/contracts.js";
import { migrationCopyTargetGeneration } from "./copy-source.js";

/**
 * Read back the copy binding digest (D-625-6, plan-v7 A5): the
 * evidenceSha256 the activation hands to the backend publication as each
 * project's evidence is bindMigrationCopySource's bindingSha256, and this
 * item must never call bindMigrationCopySource itself -- the binding's
 * seal-once-read-back stability lives in apply-genesis-copy.ts's gating,
 * not in the binder, which would happily rebind with whatever
 * destinationCapturedAt it is handed. The durable copy of that digest is
 * the lcm.transfer_runs row the copy wrote: its run_id is
 * "migration-copy-" + bindingSha256 (copy-source.ts), keyed by
 * (project_id, target_generation) where target_generation is
 * migrationCopyTargetGeneration(generationId). UNIQUE
 * (project_id, target_generation) makes at most one row possible.
 *
 * projectId is the manifest destination's remote project UUID (the ledger
 * keys on the remote id, exactly as verify-generation.ts's own ledger reads
 * do), never a local project hash.
 *
 * Three-valued, never null: resolved with the digest, or unresolvable with
 * a reason -- no row, a row that has not reached "completed" (the copy is
 * not final, so its digest is not yet evidence), a run_id that is not the
 * expected prefix plus 64 hex (the row is not a copy run this item
 * understands), or a query the storage layer reported as failed. A
 * rejection that is not a StorageOperationError is not attributed; it
 * propagates raw. Malformed input throws before any query.
 *
 * Session lifetime is the caller's: open a transfer-role session, call
 * this once, close it, all before S2 (plan-v7.1 amendment 4). S7's census
 * must open its own snapshot; this read must not share one.
 */

const RUN_ID_PREFIX = "migration-copy-";
const RUN_ID_PATTERN = /^migration-copy-([0-9a-f]{64})$/u;
const GENERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type MigrationCopyBindingUnresolvableReason =
  | "no-run"
  | "run-not-completed"
  | "run-id-malformed"
  | "query-failed";

export type MigrationCopyBindingReadResult = Readonly<
  | { state: "resolved"; evidenceSha256: string; runId: string; targetGenerationId: string }
  | { state: "unresolvable"; reason: MigrationCopyBindingUnresolvableReason; detail: string; targetGenerationId: string }
>;

export class MigrationCopyBindingReadError extends Error {
  constructor(readonly reason: "invalid-input", message: string) {
    super(message);
    this.name = "MigrationCopyBindingReadError";
  }
}

export type ReadMigrationCopyBindingInput = Readonly<{
  /** A transfer-role query seam (runtime or snapshot session). */
  executor: PostgreSqlQueryExecutor;
  /** The manifest destination's remote project UUIDv7. */
  projectId: string;
  generationId: string;
  signal?: AbortSignal;
}>;

type TransferRunRow = { run_id: unknown; state: unknown };

export async function readMigrationCopyBindingSha256(
  input: ReadMigrationCopyBindingInput,
): Promise<MigrationCopyBindingReadResult> {
  const projectId = typeof input?.projectId === "string" ? normalizeUuidV7(input.projectId) : null;
  if (
    typeof input !== "object"
    || input === null
    || typeof input.executor?.query !== "function"
    || projectId === null
    || typeof input.generationId !== "string"
    || !GENERATION_ID_PATTERN.test(input.generationId)
  ) {
    throw new MigrationCopyBindingReadError("invalid-input", "migration copy binding read input is invalid");
  }
  const targetGenerationId = migrationCopyTargetGeneration(input.generationId);
  const unresolvable = (reason: MigrationCopyBindingUnresolvableReason, detail: string): MigrationCopyBindingReadResult =>
    ({ state: "unresolvable", reason, detail, targetGenerationId });

  let rows: readonly TransferRunRow[];
  try {
    const result = await input.executor.query<TransferRunRow>({
      text: "SELECT run_id, state FROM lcm.transfer_runs WHERE project_id = $1::uuid AND target_generation = $2",
      values: [projectId, targetGenerationId],
    }, { domain: "factory", operation: "readMigrationCopyBinding", signal: input.signal });
    rows = result.rows;
  } catch (error) {
    if (error instanceof StorageOperationError) {
      return unresolvable(
        "query-failed",
        "the transfer ledger could not be read (" + error.name + " " + error.code + ", operation " + error.operation + ")",
      );
    }
    throw error;
  }

  const row = rows[0];
  if (row === undefined) {
    return unresolvable("no-run", "no transfer run exists for project " + projectId + " and target generation " + targetGenerationId);
  }
  if (row.state !== "completed") {
    return unresolvable(
      "run-not-completed",
      "the transfer run for target generation " + targetGenerationId + " has state " + String(row.state) + ", not completed",
    );
  }
  const match = typeof row.run_id === "string" ? RUN_ID_PATTERN.exec(row.run_id) : null;
  if (match === null) {
    return unresolvable(
      "run-id-malformed",
      "the completed transfer run for target generation " + targetGenerationId + " has a run_id that is not " +
        RUN_ID_PREFIX + "<sha256>",
    );
  }
  return { state: "resolved", evidenceSha256: match[1]!, runId: row.run_id as string, targetGenerationId };
}

