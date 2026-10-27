import type { StorageBackend } from "../daemon/config.js";
import type { ActivationRestartCheckResult } from "./activation-restart-check.js";
import type { MigrationDaemonPresence } from "./daemon-presence.js";
import type { MigrationEnvelopeRestart, MigrationEvidence } from "./envelope.js";

/**
 * Plan-v4 section 7's matrix, shared by `report`, `activate` and
 * `rollback`: the restart verdict comes from the owning verifier
 * (`checkActivationRestartAdmission`) and daemon presence from the CLI's own
 * three-valued classifier. They are two observations and neither decides
 * alone:
 *
 * | Verdict      | Presence                                   | Class         |
 * | ------------ | ------------------------------------------ | ------------- |
 * | satisfied    | absent, or present with the selected backend | ok          |
 * | satisfied    | present with a stale backend, or unresolvable | contradiction |
 * | unsatisfied  | present with a stale backend               | required (8)  |
 * | unsatisfied  | anything else                              | contradiction |
 * | unresolvable | any                                        | unresolvable  |
 *
 * Each caller maps the class onto its own closed refusal reason.
 */

export type MigrationRestartClass = "ok" | "required" | "contradiction" | "unresolvable";

export type MigrationRestartCombination = Readonly<{
  class: MigrationRestartClass;
  restart: MigrationEnvelopeRestart;
  evidence: MigrationEvidence;
}>;

export function combineMigrationRestart(
  verdict: ActivationRestartCheckResult,
  presence: MigrationDaemonPresence,
  selected: StorageBackend,
): MigrationRestartCombination {
  const presenceName = presence.status === "present" ? "running" : presence.status === "authoritatively-absent" ? "absent" : "unresolvable";
  const restart = { answer: verdict.status, presence: presenceName } as const;
  const evidence = { selectedBackend: selected, restartCheckReason: verdict.reason };
  const stale = presence.status === "present" && presence.storageBackend !== selected;
  const matching = presence.status === "present" && presence.storageBackend === selected;
  if (verdict.status === "unresolvable") return { class: "unresolvable", restart, evidence };
  if (verdict.status === "satisfied") {
    return presence.status === "authoritatively-absent" || matching
      ? { class: "ok", restart, evidence }
      : { class: "contradiction", restart, evidence };
  }
  return stale ? { class: "required", restart, evidence } : { class: "contradiction", restart, evidence };
}
