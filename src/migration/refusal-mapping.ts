import type { MigrationExitClassName } from "./exit-classes.js";

/**
 * Section 12's named mechanism: "the closed refusal-reason and exit-class
 * vocabulary lives in one exported constant consumed by both the CLI and
 * the test". This is that constant. `bin/lcm.ts`'s command actions map a
 * refusal's `reason` string to an exit class and remedy by looking it up
 * here, never by re-deriving the mapping inline; the section 12 runbook
 * conformance test compares the runbook's own machine-readable inventory
 * block against this exact table in both directions.
 *
 * Every reason string a production refusal path in this candidate can
 * actually emit is listed. A reason absent from this table is a defect in
 * the table, not a signal to fall back to a guessed class — the CLI's own
 * lookup refuses (never silently defaults) when a reason is not found here,
 * matching the "never conclude from absence" rule the rest of this item is
 * built on.
 *
 * Remedies are static text, per `bin/lcm.ts:4307-4308`'s existing rule and
 * section 10's: never interpolates a message, a driver error, or any other
 * dynamic value.
 */

export type MigrationRefusalMapping = Readonly<{
  reason: string;
  exitClass: MigrationExitClassName;
  remedy: string;
}>;

/**
 * Section 5.1's row-level rule, restated per entry so it is checkable
 * mechanically rather than only in prose: `incomplete-recoverable` (exit 6)
 * requires that `resume` can genuinely finish the state. Only the router's
 * `route-resume-required` claims it: the cell has a pending effect that
 * `resume` completes. Every other held-plus-unsettled case is
 * `refused-precondition` (exit 2) naming `abort`, never exit 6, exactly as
 * section 5 requires for an unresumable state.
 */
export const MIGRATION_REFUSAL_REASONS: readonly MigrationRefusalMapping[] = Object.freeze([
  // --- Round-1 B-4: the boundary catch's closed reason for a throw nothing
  // classified. Evidence is only the error's name. ---
  Object.freeze({
    reason: "unexpected-failure", exitClass: "refused-evidence",
    remedy: "The command hit an unexpected internal failure. Run `lcm doctor`, then `lcm migration plan` to see the current state, and file an issue quoting the evidence.",
  }),

  // --- Section 4.4/4.9's genesis-and-copy ownership plumbing, and the
  // target resolution the root ruled on (docs/migration-operations.md
  // documents storage.backend vs storage.postgresql's split explicitly). ---
  Object.freeze({
    reason: "invalid-expected-owner", exitClass: "refused-precondition",
    remedy: "storage.postgresql.migrationRole (or LCM_POSTGRES_MIGRATION_ROLE) is not a valid PostgreSQL role name. Fix the configured value before retrying.",
  }),
  Object.freeze({
    reason: "machine-identity-unregistered", exitClass: "refused-precondition",
    remedy: "This machine has no registered PostgreSQL identity. Run `lcm machine register` before retrying.",
  }),
  // --- Plan-v5 Part B (3): the held-safe identity split. ---
  Object.freeze({
    reason: "local-identity-unresolvable", exitClass: "refused-evidence",
    remedy: "This project's persisted identity could not be read. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "local-identity-not-persisted", exitClass: "refused-evidence",
    remedy: "A maintenance hold exists but the current directory has no persisted project identity, and nothing is minted under a hold. Run the command from the migrated project's directory; if it is already there, run `lcm doctor`. `lcm migration abort` releases the hold.",
  }),
  Object.freeze({
    reason: "destination-project-absent", exitClass: "refused-evidence",
    remedy: "A maintenance hold exists but the destination PostgreSQL project does not, and nothing is created under a hold. Run `lcm doctor`; `lcm migration abort` releases the hold.",
  }),
  Object.freeze({
    reason: "migration-target-identity-unresolvable", exitClass: "refused-evidence",
    remedy: "The destination PostgreSQL project identity could not be resolved or minted. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "migration-target-missing", exitClass: "refused-precondition",
    remedy: "No usable PostgreSQL target is configured. Set storage.postgresql (url, caFile, migrationRole) or the LCM_POSTGRES_URL / LCM_POSTGRES_CA_FILE / LCM_POSTGRES_MIGRATION_ROLE environment variables.",
  }),
  Object.freeze({
    reason: "migration-target-unresolvable", exitClass: "refused-evidence",
    remedy: "The PostgreSQL target configuration could not be read or parsed. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "migration-target-verification-failed", exitClass: "refused-precondition",
    remedy: "The PostgreSQL target was reached but failed TLS or migration-role verification. Fix the role grants or TLS configuration, then retry.",
  }),
  Object.freeze({
    reason: "migration-target-verification-unresolvable", exitClass: "refused-evidence",
    remedy: "The PostgreSQL target could not be reached to verify TLS or role access. Check network connectivity and the target address, then retry.",
  }),

  // --- dry-run's own refusal (section 3: owns dryRunAuthenticatedSqliteMigrationSource only) ---
  Object.freeze({
    reason: "dry-run-failed", exitClass: "refused-evidence",
    remedy: "The SQLite source could not be dry-run checked. Run `lcm doctor` before retrying.",
  }),

  // --- Section 4.2: journal observation ---
  Object.freeze({
    reason: "publication-occupies-slot", exitClass: "refused-contention",
    remedy: "A v2 publication is in progress. Wait for it to complete, then retry.",
  }),
  Object.freeze({
    reason: "journal-unresolvable", exitClass: "refused-evidence",
    remedy: "The maintenance journal could not be read. Run `lcm doctor` and inspect the backend publication directory under your LCM home before retrying.",
  }),

  // --- Section 4.9 exposure 1: generation identity resolution ---
  Object.freeze({
    reason: "generation-occupied-since-probe", exitClass: "refused-contention",
    remedy: "Another local actor took the candidate generation between the probe and the hold. Retry.",
  }),
  Object.freeze({
    reason: "generation-unresolvable-since-probe", exitClass: "refused-evidence",
    remedy: "The candidate generation could not be re-verified immediately before the hold. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "generation-probe-bound-exceeded", exitClass: "refused-precondition",
    remedy: "Every candidate ordinal up to the probe bound is occupied. Clean up terminal generations, then retry.",
  }),
  Object.freeze({
    reason: "generation-occupancy-refused", exitClass: "refused-evidence",
    remedy: "A candidate generation's occupancy could not be classified. Run `lcm doctor` before retrying.",
  }),
  // Section 5's corrected exit-7 row: "see applied". Neither of these two
  // producers mutates anything, unlike exit 7's other producer (section 8's
  // unsettled-pair case), so applied is always false here; the reason
  // string is what distinguishes them for the operator.
  Object.freeze({
    reason: "generation-invalid-input", exitClass: "failed-operator-required",
    remedy: "The CLI constructed an invalid candidate generation identity. This is an internal defect; file an issue rather than retrying.",
  }),
  Object.freeze({
    reason: "generation-identifier-bound-exceeded", exitClass: "failed-operator-required",
    remedy: "A candidate generation id exceeded the identifier length bound. This is an internal defect; file an issue rather than retrying.",
  }),

  // --- Section 4.4: multi-machine installation ---
  Object.freeze({
    reason: "multi-machine-installation", exitClass: "refused-precondition",
    remedy: "This project is shared across machines. SQLite-to-PostgreSQL migration requires a single-machine (local) project.",
  }),

  // --- Section 4.4/4.9: hold entry ---
  // Round-1 B-5/A-11: the fresh hold entry's failures are classified by
  // reason, each with a remedy that matches the fact. None of them names
  // `abort`: no hold of ours exists yet at this point.
  Object.freeze({
    reason: "hold-entry-contention", exitClass: "refused-contention",
    remedy: "Another actor holds the publication lock, so the maintenance hold was not entered. Wait, then retry `lcm migration apply`.",
  }),
  Object.freeze({
    reason: "hold-entry-slot-occupied", exitClass: "refused-contention",
    remedy: "A publication or another maintenance hold occupies the journal slot. Wait for it to finish, then re-run `lcm migration plan`.",
  }),
  Object.freeze({
    reason: "hold-entry-precondition", exitClass: "refused-precondition",
    remedy: "The maintenance journal changed while the hold was being entered. Re-run `lcm migration plan` and confirm the id it prints.",
  }),
  Object.freeze({
    reason: "hold-entry-evidence", exitClass: "refused-evidence",
    remedy: "The maintenance journal could not be read or verified while entering the hold. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "hold-entry-readback-mismatch", exitClass: "refused-evidence",
    remedy: "The maintenance hold could not be confirmed after being entered. Run `lcm doctor` before retrying.",
  }),

  // --- Section 4.8: capture ---
  Object.freeze({
    reason: "capture-failed", exitClass: "failed-operator-required",
    remedy: "SQLite snapshot capture failed after the hold was taken. Run `lcm migration abort` to release the hold, then investigate before retrying.",
  }),

  // Round-1 A-9: capture's contention and journal failures are siblings of
  // capture-failed, so only capture's own failures stay exit 7. The hold is
  // in place for all three.
  Object.freeze({
    reason: "capture-contention", exitClass: "refused-contention",
    remedy: "Another actor held a lock during capture. The maintenance hold is still in place; re-run `lcm migration apply` with the same --confirm-generation to continue, or run `lcm migration abort` to release it.",
  }),
  Object.freeze({
    reason: "capture-unresolvable", exitClass: "refused-evidence",
    remedy: "The maintenance journal could not be verified during capture. The maintenance hold is still in place; run `lcm doctor`, then re-run `lcm migration apply` to continue or `lcm migration abort` to release it.",
  }),

  // --- Section 4.5: continuation match predicates ---
  Object.freeze({
    reason: "continuation-mismatched-hold", exitClass: "refused-precondition",
    remedy: "An existing maintenance hold does not match this project's current selection. Run `lcm migration abort` before retrying.",
  }),
  Object.freeze({
    reason: "continuation-partial-snapshot", exitClass: "refused-precondition",
    remedy: "The held generation's snapshot is partial or replaced and cannot be resumed. Run `lcm migration abort` to release the hold; the captured evidence is preserved.",
  }),
  Object.freeze({
    reason: "continuation-snapshot-tampered", exitClass: "refused-evidence",
    remedy: "The held generation's snapshot failed its integrity classification. The captured evidence is preserved and no command repairs it. Run `lcm doctor` and inspect the snapshot before deciding; `lcm migration abort` releases the hold without touching the evidence.",
  }),
  Object.freeze({
    reason: "continuation-resume-required", exitClass: "refused-precondition",
    remedy: "A prior cutover reached a state only `resume` can continue. Run `lcm migration resume`.",
  }),
  Object.freeze({
    reason: "continuation-unclassified", exitClass: "failed-operator-required",
    remedy: "The maintenance journal's phase could not be classified into a known continuation. This is an internal defect; file an issue.",
  }),

  // --- Section 4.6: the abort gate ---
  Object.freeze({
    reason: "abort-gate-unresolvable", exitClass: "refused-evidence",
    remedy: "The manifest for a terminal generation could not be read. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "abort-or-resume-required", exitClass: "refused-precondition",
    remedy: "A terminal maintenance journal has an unsettled manifest. Run `lcm migration abort` or `lcm migration resume` before starting a fresh cutover.",
  }),

  // --- A-1 recovery (maintenance-entering) ---
  Object.freeze({
    reason: "entering-recovery-precondition", exitClass: "refused-precondition",
    remedy: "The recovered entering journal does not match this project's current selection. Run `lcm migration abort` before retrying.",
  }),
  Object.freeze({
    reason: "entering-recovery-contention", exitClass: "refused-contention",
    remedy: "Another actor holds the publication lock during recovery. Wait and retry.",
  }),
  Object.freeze({
    reason: "entering-recovery-evidence", exitClass: "refused-evidence",
    remedy: "The entering journal's recovery could not be verified. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "entering-recovery-unclassified", exitClass: "failed-operator-required",
    remedy: "The entering journal's recovery failure could not be classified. This is an internal defect; file an issue.",
  }),

  // --- Section 8: manifest genesis and copy ---
  Object.freeze({
    reason: "snapshot-unresolvable", exitClass: "refused-evidence",
    remedy: "The captured SQLite snapshot could not be classified. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "capture-incomplete", exitClass: "refused-precondition",
    remedy: "Capture-before-genesis ordering requires a complete snapshot before manifest genesis. Retry `lcm migration apply`.",
  }),
  Object.freeze({
    reason: "manifest-unresolvable", exitClass: "refused-evidence",
    remedy: "The migration manifest could not be read. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "genesis-inspection-failed", exitClass: "failed-operator-required",
    remedy: "Inspecting the source and destination witnesses for manifest genesis failed. Investigate the target PostgreSQL connection before retrying.",
  }),
  Object.freeze({
    reason: "genesis-create-failed", exitClass: "failed-operator-required",
    remedy: "Manifest genesis failed after a successful capture. Run `lcm doctor`; the snapshot is preserved and safe to retry from.",
  }),
  Object.freeze({
    reason: "genesis-dry-run-begin-failed", exitClass: "failed-operator-required",
    remedy: "Beginning the dry-run copy effect failed. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "genesis-dry-run-complete-failed", exitClass: "failed-operator-required",
    remedy: "Completing the dry-run copy effect failed. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "genesis-dry-run-effect-mismatch", exitClass: "refused-evidence",
    remedy: "The pending dry-run effect is not the one resume carried. Nothing was changed; run `lcm migration report` and inspect the evidence.",
  }),
  Object.freeze({
    reason: "genesis-dry-run-unexpected-state", exitClass: "refused-precondition",
    remedy: "The manifest is no longer waiting for its dry-run effect. Nothing was changed; run `lcm migration report` to see which command owns it now.",
  }),
  Object.freeze({
    reason: "resume-readback-mismatch", exitClass: "refused-evidence",
    remedy: "The resumed step appeared to complete but the manifest does not read back at the expected checkpoint. Run `lcm migration report` and inspect the evidence.",
  }),
  Object.freeze({
    reason: "copy-failed", exitClass: "failed-operator-required",
    remedy: "Copying captured data to the destination failed. The source snapshot is preserved; run `lcm doctor` before retrying.",
  }),

  // --- Section 9: confirmation fence ---
  Object.freeze({
    reason: "confirmation-missing", exitClass: "refused-confirmation",
    remedy: "Run `lcm migration plan` first, then pass its printed generation id to `apply --confirm-generation <id>`.",
  }),
  Object.freeze({
    reason: "confirmation-generation-moved", exitClass: "refused-confirmation",
    remedy: "The candidate generation changed since `lcm migration plan` was run. Re-run `lcm migration plan` and confirm the new id.",
  }),

  // --- Section 7: daemon presence policy ---
  Object.freeze({
    reason: "daemon-presence-unresolvable", exitClass: "refused-evidence",
    remedy: "Daemon presence could not be positively established. Run `lcm daemon status`, resolve the failure, and retry.",
  }),

  // --- abort's own refusals, classified by classifyMigrationAbortRefusal
  // (abort.ts) rather than by the raw evidence string, for the exact
  // reason recorded there: a wrong phase, a coordinator CAS mismatch, an
  // internal-defect malformed input, and "resume is required" are
  // different facts, and every reason this classifier cannot positively
  // attribute lands on abort-unresolvable rather than being guessed. ---
  Object.freeze({
    reason: "abort-wrong-phase", exitClass: "refused-precondition",
    remedy: "The maintenance journal is not in an abortable phase (it is either absent or already past a successful cutover). Nothing to abort.",
  }),
  Object.freeze({
    reason: "abort-journal-moved", exitClass: "refused-precondition",
    remedy: "The maintenance journal changed since it was last observed. Re-run `lcm migration abort` to act on its current state.",
  }),
  Object.freeze({
    reason: "abort-invalid-input", exitClass: "failed-operator-required",
    remedy: "The CLI constructed an invalid abort request. This is an internal defect; file an issue rather than retrying.",
  }),
  Object.freeze({
    reason: "abort-manifest-needs-resume", exitClass: "incomplete-recoverable",
    remedy: "A copy or verification effect began on this generation's manifest after the router chose abort. Nothing was changed. Run `lcm migration resume` to finish it, then abort if you still want to.",
  }),
  Object.freeze({
    reason: "abort-unresolvable", exitClass: "refused-evidence",
    remedy: "The abort could not be classified into a known precondition or defect. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "abort-confirmation-missing", exitClass: "refused-confirmation",
    remedy: "Pass --confirm-generation with the generation id of the live maintenance hold. This refusal reports that id in its generation field; nothing was changed.",
  }),
  Object.freeze({
    reason: "abort-confirmation-moved", exitClass: "refused-confirmation",
    remedy: "--confirm-generation does not match the live maintenance hold. Pass the generation id this refusal reports; nothing was changed.",
  }),
  Object.freeze({
    reason: "abort-nothing-to-abort", exitClass: "refused-precondition",
    remedy: "There is no maintenance hold to abort.",
  }),
  // --- Plan-v5 Part B (1): resolving an existing generation, and the router's
  // refusals for a command that is not the cell's owner. ---
  Object.freeze({
    reason: "generation-required", exitClass: "refused-precondition",
    remedy: "No live maintenance hold identifies the generation. Pass --generation <id>; `lcm migration report` lists what is known.",
  }),
  Object.freeze({
    reason: "generation-unknown", exitClass: "refused-precondition",
    remedy: "No journal or manifest exists for that generation id. Check the id passed to --generation.",
  }),
  Object.freeze({
    reason: "generation-invalid", exitClass: "usage",
    remedy: "The value passed to --generation is not a valid generation id. Nothing was read or changed.",
  }),
  Object.freeze({
    reason: "route-not-owner", exitClass: "refused-precondition",
    remedy: "This generation's state is owned by a different command. Run the command this refusal names as next; nothing was changed.",
  }),
  Object.freeze({
    reason: "route-publication-in-flight", exitClass: "refused-contention",
    remedy: "A v2 publication occupies the journal slot for this generation. Wait for it to settle, then run `lcm migration report`.",
  }),
  Object.freeze({
    reason: "route-resume-required", exitClass: "incomplete-recoverable",
    remedy: "This generation has durably begun work that only `lcm migration resume` (or `verify` where this refusal names it) can finish. Nothing was changed.",
  }),
  Object.freeze({
    reason: "route-operator-required", exitClass: "failed-operator-required",
    remedy: "No automatic command settles this generation's state. Nothing was changed; run `lcm migration report` and inspect the evidence.",
  }),
  Object.freeze({
    reason: "route-unresolvable", exitClass: "refused-evidence",
    remedy: "The maintenance journal could not be read, so no command can be chosen. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "route-foreign-publication", exitClass: "refused-evidence",
    remedy: "The journal slot holds a publication that does not belong to this generation. Nothing was changed; run `lcm migration report`.",
  }),
  Object.freeze({
    reason: "route-contradiction", exitClass: "refused-evidence",
    remedy: "The journal, manifest and snapshot of this generation contradict each other. Nothing was changed; run `lcm doctor` and inspect the evidence.",
  }),
  // --- Confirmation for the existing-generation commands (verify, resume). ---
  Object.freeze({
    reason: "existing-confirmation-missing", exitClass: "refused-confirmation",
    remedy: "Pass --confirm-generation with the generation id this refusal reports; nothing was changed.",
  }),
  Object.freeze({
    reason: "existing-confirmation-moved", exitClass: "refused-confirmation",
    remedy: "--confirm-generation does not match the resolved generation. Pass the id this refusal reports; nothing was changed.",
  }),

  // --- verify (plan-v4 section 5, plan-v5 Part B (2)). ---
  Object.freeze({
    reason: "verify-contention", exitClass: "refused-contention",
    remedy: "Another worker holds the verification lease or the source append barrier, or the lease was lost. No effect was begun; run `lcm migration verify` again.",
  }),
  Object.freeze({
    reason: "verify-not-eligible", exitClass: "refused-evidence",
    remedy: "The verification found mismatches or incomplete coverage. A non-eligible report is kept as evidence, and the generation stays copied. Run `lcm migration report` and inspect it.",
  }),
  Object.freeze({
    reason: "verify-project-map-drift", exitClass: "refused-evidence",
    remedy: "The project map no longer matches the generation's destination project. Nothing was changed; run `lcm doctor` and inspect the project map.",
  }),
  Object.freeze({
    reason: "verify-project-map-unresolvable", exitClass: "refused-evidence",
    remedy: "The project map could not be read for the verification witness. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "verify-report-identity-conflict", exitClass: "refused-evidence",
    remedy: "The pending verification effect does not name an activation-eligible persisted report. Nothing was changed; run `lcm doctor` and inspect the evidence.",
  }),
  Object.freeze({
    reason: "verify-destination-drift", exitClass: "refused-evidence",
    remedy: "The persisted verification report does not match the destination the copy sealed in the manifest. Nothing was changed; the evidence is preserved.",
  }),
  Object.freeze({
    reason: "verify-invalid-input", exitClass: "failed-operator-required",
    remedy: "The CLI constructed an invalid verification request. This is an internal defect; file an issue rather than retrying.",
  }),
  Object.freeze({
    reason: "verify-report-unresolvable", exitClass: "refused-evidence",
    remedy: "The persisted verification report could not be read. Run `lcm doctor` before retrying.",
  }),
  Object.freeze({
    reason: "verify-readback-mismatch", exitClass: "refused-evidence",
    remedy: "The verification appeared to complete but the manifest and its report do not read back as verified. Run `lcm migration report` and inspect the evidence.",
  }),
  // --- report (plan-v4 section 7): the restart observations. ---
  Object.freeze({
    reason: "report-restart-required", exitClass: "restart-required",
    remedy: "The durable selection is correct, but a running daemon still holds the previous startup backend. Restart the daemon (`lcm daemon restart`), then run `lcm migration report` again.",
  }),
  Object.freeze({
    reason: "report-restart-contradiction", exitClass: "refused-evidence",
    remedy: "The daemon restart check and the daemon presence observation disagree, so neither can be trusted alone. Run `lcm daemon status`, resolve the difference, and report again.",
  }),
  Object.freeze({
    reason: "report-restart-unresolvable", exitClass: "refused-evidence",
    remedy: "The daemon restart check could not be made. Run `lcm daemon status`, resolve the failure, and report again.",
  }),
  Object.freeze({
    reason: "report-selection-unresolvable", exitClass: "refused-evidence",
    remedy: "The journal records a completed selection without naming its backend. Nothing was changed; run `lcm doctor` and inspect the evidence.",
  }),
  Object.freeze({
    reason: "report-evidence-unresolvable", exitClass: "refused-evidence",
    remedy: "A reader of the activation or rollback evidence could not give an answer, or a report the manifest references (including the verification report) is missing or unreadable. The report still prints every section it read; run `lcm doctor` and inspect the evidence named as unresolvable or missing.",
  }),
  Object.freeze({
    reason: "abort-carried-effect-mismatch", exitClass: "refused-evidence",
    remedy: "The pending abort effect on the manifest is not the one an abort of this generation begins. Nothing was changed; run `lcm doctor` and inspect the evidence.",
  }),
  Object.freeze({
    reason: "abort-other-generation", exitClass: "refused-precondition",
    remedy: "The terminal maintenance journal belongs to a different generation than the one named. Nothing was changed; omit --generation to act on the journal's own generation.",
  }),
  Object.freeze({
    reason: "abort-readback-mismatch", exitClass: "failed-operator-required",
    remedy: "The abort appeared to complete but its terminal state could not be confirmed on readback. Run `lcm doctor` and inspect the maintenance journal and manifest directly.",
  }),
  // --- activate (plan-v6.1 B1, plan-v6.2): the closed outcome table. The
  // refused reasons collapse into four classes; the evidence names the step
  // and the upstream reason. ---
  Object.freeze({
    reason: "backend-confirmation-missing", exitClass: "refused-confirmation",
    remedy: "Pass --confirm-backend with the backend this command switches to: postgresql for activate, sqlite for rollback. Nothing was changed.",
  }),
  Object.freeze({
    reason: "backend-confirmation-moved", exitClass: "refused-confirmation",
    remedy: "--confirm-backend does not match the backend this command switches to (postgresql for activate, sqlite for rollback). Nothing was changed.",
  }),
  Object.freeze({
    reason: "activation-refused-precondition", exitClass: "refused-precondition",
    remedy: "Activation was refused before it began any effect: the evidence names the step and the reason. Fix that condition, then run `lcm migration activate` again. `lcm migration report` shows the current state.",
  }),
  Object.freeze({
    reason: "activation-runtime-target-missing", exitClass: "refused-precondition",
    remedy: "Activation requires LCM_POSTGRES_RUNTIME_URL for the daemon runtime role. Set it to a strict postgresql:// URL for the verified destination, without query parameters or a fragment, then retry.",
  }),
  Object.freeze({
    reason: "activation-refused-contention", exitClass: "refused-contention",
    remedy: "Another actor holds the activation lease. Nothing was changed; wait for it to finish or expire, then run `lcm migration activate` again.",
  }),
  Object.freeze({
    reason: "activation-refused-evidence", exitClass: "refused-evidence",
    remedy: "Activation could not establish a fact it needs and refused before it began any effect: the evidence names the step and the reason. Run `lcm doctor` and `lcm migration report` before retrying.",
  }),
  Object.freeze({
    reason: "activation-refused-resume", exitClass: "incomplete-recoverable",
    remedy: "A pending effect on this generation is finished by `lcm migration resume`. Nothing was changed; run it with the same --confirm-generation.",
  }),
  Object.freeze({
    reason: "activation-not-begun", exitClass: "refused-precondition",
    remedy: "Activation was interrupted before its first durable effect, so the manifest is unchanged. A lease it took may be held until it expires (15 minutes) or a later run takes it over; run `lcm migration activate` again.",
  }),
  Object.freeze({
    reason: "activation-interrupted", exitClass: "incomplete-recoverable",
    remedy: "Activation was interrupted after beginning durable work. Run `lcm migration activate` again with the same confirmations; the re-entry finishes it. The evidence names the step, the cause and what is known to have been applied.",
  }),
  Object.freeze({
    reason: "activation-publication-failed", exitClass: "refused-evidence",
    remedy: "The backend publication did not complete: the evidence names its status. Run `lcm migration report` and inspect the evidence before deciding between `activate` again and `rollback`.",
  }),
  Object.freeze({
    reason: "activation-post-publication-unhealthy", exitClass: "refused-evidence",
    remedy: "The publication completed but the PostgreSQL target did not pass its health check, so the cutover is not complete. Fix the target (the evidence names the reason), then run `lcm migration activate` again.",
  }),
  Object.freeze({
    reason: "activation-identity-mismatch", exitClass: "refused-evidence",
    remedy: "Activation answered for a generation other than the one confirmed, so its result is not accepted. Run `lcm migration report` for each generation and inspect the evidence.",
  }),
  Object.freeze({
    reason: "activation-readback-mismatch", exitClass: "refused-evidence",
    remedy: "Activation reported success but the manifest does not read back as active with nothing pending. Run `lcm migration report` and inspect the evidence.",
  }),
  Object.freeze({
    reason: "activation-invalid-input", exitClass: "refused-evidence",
    remedy: "The activation request was rejected as invalid before anything ran. This is an internal defect; file an issue with the evidence.",
  }),
  Object.freeze({
    reason: "activation-unexpected-state", exitClass: "refused-evidence",
    remedy: "Activation found state it does not recognise and stopped. Run `lcm migration report` and inspect the evidence before retrying.",
  }),
  Object.freeze({
    reason: "activation-dry-run-not-predictive", exitClass: "refused-evidence",
    remedy: "The activation preview reads the persisted state but does not evaluate quiescence, coverage, the project-coverage refusal, the lease, target health or the census, so it cannot say activation would succeed. The evidence lists what it read and what it did not.",
  }),
  Object.freeze({
    reason: "cutover-restart-required", exitClass: "restart-required",
    remedy: "The durable selection is correct, but a running daemon still holds the previous startup backend. Revoke the transfer grants, restart the daemon with LCM_POSTGRES_URL set to the proven runtime role, then run `lcm migration report`.",
  }),
  Object.freeze({
    reason: "cutover-restart-contradiction", exitClass: "refused-evidence",
    remedy: "The daemon restart check and the daemon presence observation disagree, so neither can be trusted alone. Run `lcm daemon status`, resolve the difference, and run `lcm migration report`.",
  }),
  Object.freeze({
    reason: "cutover-restart-unresolvable", exitClass: "refused-evidence",
    remedy: "The daemon restart check could not be made. Run `lcm daemon status`, resolve the failure, and run `lcm migration report`.",
  }),
  // --- rollback (plan-v5 Part B (4), plan-v6.1 B2, A-P0-2). The seven
  // MigrationRollbackError reasons collapse into three classes; the evidence
  // names the upstream reason. ---
  Object.freeze({
    reason: "rollback-refused-precondition", exitClass: "refused-precondition",
    remedy: "Rollback refused because the generation is not eligible or the installation is not quiescent: the evidence names which. Rollback also refuses while any other project is remotely bound, because the backend selection is global. Fix the named condition, then run `lcm migration rollback` again.",
  }),
  Object.freeze({
    reason: "rollback-contention", exitClass: "refused-contention",
    remedy: "The rollback lease was lost or is held by another actor. Re-running `lcm migration rollback` with the same confirmations re-enters whatever was begun.",
  }),
  Object.freeze({
    reason: "rollback-refused-evidence", exitClass: "refused-evidence",
    remedy: "Rollback could not establish a fact it needs, or found state that contradicts the generation: the evidence names which. Run `lcm doctor` and `lcm migration report` and inspect the evidence before retrying. If the evidence names unexpected-state, check that LCM_POSTGRES_URL is the runtime role's connection (not the transfer role's) and that migrationRole is still the schema owner.",
  }),
  Object.freeze({
    reason: "rollback-abandoned", exitClass: "refused-precondition",
    remedy: "An interrupted publication could not be proven complete, so rollback abandoned it and the generation returned to its previous phase with an abandonment report. Nothing was rolled back; run `lcm migration rollback` again.",
  }),
  Object.freeze({
    reason: "rollback-readback-mismatch", exitClass: "refused-evidence",
    remedy: "Rollback reported a result that the manifest does not read back as rolled-back with nothing pending. Run `lcm migration report` and inspect the evidence.",
  }),
  Object.freeze({
    reason: "rollback-dry-run-not-predictive", exitClass: "refused-evidence",
    remedy: "The rollback preview reads only the route and the manifest. It does not evaluate eligibility, mode, quiescence, the lease, drift, remote bindings or the restart check, so it cannot say rollback would succeed.",
  }),
  // --- The cutover-set commands (`--set`, #1551): one shared bucket per
  // exit class. The closed service reason, step and cause, and the owning
  // command, travel in the evidence; the remedy names only `--set` and the
  // aggregate confirmation. ---
  Object.freeze({
    reason: "set-refused-precondition", exitClass: "refused-precondition",
    remedy: "The cutover set's state, scope or capacity does not admit this command, and nothing it owns was changed: the evidence names the owning command and the closed reason. Fix that condition, or run the command the evidence names, always with --set.",
  }),
  Object.freeze({
    reason: "set-refused-contention", exitClass: "refused-contention",
    remedy: "Another actor holds a lock, lease or journal slot this set command needs. Wait for it to finish or expire, then run the same command again with --set; the evidence names the closed reason.",
  }),
  Object.freeze({
    reason: "set-refused-evidence", exitClass: "refused-evidence",
    remedy: "The cutover set command could not establish or confirm a fact it needs, or found evidence that contradicts the set: the evidence names the owning command and the closed reason. Run `lcm doctor` and `lcm migration report --set --generation <set-id>` and inspect it before retrying.",
  }),
  Object.freeze({
    reason: "set-incomplete", exitClass: "incomplete-recoverable",
    remedy: "The cutover set operation was durably begun and `lcm migration resume --set --generation <set-id> --confirm-generation <set-id>` can finish it. Use the original set id the plan printed; the evidence names the closed reason.",
  }),
  Object.freeze({
    reason: "set-operator-required", exitClass: "failed-operator-required",
    remedy: "No automatic command settles this cutover set. Run `lcm migration report --set --generation <set-id>` and inspect the evidence; `lcm migration abort --set` releases a held preparation and keeps its evidence.",
  }),
  Object.freeze({
    reason: "set-preview-not-predictive", exitClass: "refused-evidence",
    remedy: "The --set preview reads persisted state and names the route; it does not evaluate the checks that decide the command, so it cannot say the command would succeed. Verify only confirms persisted evidence. The evidence lists what was read and what was not.",
  }),
  Object.freeze({
    reason: "set-generation-required", exitClass: "refused-precondition",
    remedy: "Pass --generation with the original cutover set id that `lcm migration plan --set` printed. Nothing is inferred from the live hold, and nothing was read or changed.",
  }),
  Object.freeze({
    reason: "set-generation-invalid", exitClass: "usage",
    remedy: "The value passed to --generation is not a valid cutover set id. Nothing was read or changed.",
  }),
  Object.freeze({
    reason: "set-original-generation-required", exitClass: "refused-precondition",
    remedy: "The id names the rollback hold or publication, not the original activated set. Pass the original set id that plan --set or activate --set printed; nothing was changed.",
  }),
  Object.freeze({
    reason: "set-confirmation-missing", exitClass: "refused-confirmation",
    remedy: "Pass --confirm-generation with the aggregate set id this refusal reports (never a member generation id); nothing was changed.",
  }),
  Object.freeze({
    reason: "set-confirmation-moved", exitClass: "refused-confirmation",
    remedy: "--confirm-generation does not match the set. Pass the aggregate set id this refusal reports, or re-run plan --set if the candidate moved (never a member generation id); nothing was changed.",
  }),
  // `activate --set` is still transfer-only: its restart refusal names the
  // full grant swap, where the single-generation one names the revoke alone.
  Object.freeze({
    reason: "set-restart-required", exitClass: "restart-required",
    remedy: "The set's durable selection is correct, but a running daemon still holds the previous startup backend. Swap the grants (add the runtime grants to the daemon runtime role, then revoke the transfer grants), restart the daemon with LCM_POSTGRES_URL set to that runtime role, then run `lcm migration report --set --generation <set-id>`.",
  }),
] satisfies MigrationRefusalMapping[]);

const REFUSAL_BY_REASON: ReadonlyMap<string, MigrationRefusalMapping> = new Map(
  MIGRATION_REFUSAL_REASONS.map((entry) => [entry.reason, entry]),
);

/**
 * Looks up a refusal reason's exit class and remedy. Refuses (throws)
 * rather than returning a guessed default when the reason is not in the
 * table: an unclassified refusal reason reaching the CLI is a defect in
 * this table, and silently defaulting it to some exit class would hide
 * that defect behind a plausible-looking exit code instead of surfacing it.
 */
export function migrationRefusalMapping(reason: string): MigrationRefusalMapping {
  const found = REFUSAL_BY_REASON.get(reason);
  if (found === undefined) {
    throw new Error(`migration CLI has no exit-class mapping for refusal reason: ${reason}`);
  }
  return found;
}
