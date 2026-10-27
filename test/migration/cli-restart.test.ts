import { describe, expect, it } from "vitest";
import type { ActivationRestartCheckResult } from "../../src/migration/activation-restart-check.js";
import { combineMigrationRestart } from "../../src/migration/cli-restart.js";
import type { MigrationDaemonPresence } from "../../src/migration/daemon-presence.js";

function verdict(status: ActivationRestartCheckResult["status"]): ActivationRestartCheckResult {
  return {
    status, reason: status === "satisfied" ? "backend-matches" : status === "unsatisfied" ? "backend-stale" : "health-unreachable",
    detail: "x", pid: 7, observedBackend: null, selectedBackend: "postgresql",
  };
}
const present = (storageBackend: string): MigrationDaemonPresence => ({ status: "present", storageBackend, pid: 7, daemonInstanceId: "d" });
const ABSENT: MigrationDaemonPresence = { status: "authoritatively-absent" };
const UNRESOLVABLE: MigrationDaemonPresence = { status: "unresolvable", evidence: "pidfile-live-no-answer" };

describe("combineMigrationRestart (plan-v4 section 7: two observations, neither deciding alone)", () => {
  it.each([
    ["satisfied", ABSENT, "ok", "absent"],
    ["satisfied", present("postgresql"), "ok", "running"],
    ["satisfied", present("sqlite"), "contradiction", "running"],
    ["satisfied", UNRESOLVABLE, "contradiction", "unresolvable"],
    ["unsatisfied", present("sqlite"), "required", "running"],
    ["unsatisfied", present("postgresql"), "contradiction", "running"],
    ["unsatisfied", ABSENT, "contradiction", "absent"],
    ["unsatisfied", UNRESOLVABLE, "contradiction", "unresolvable"],
    ["unresolvable", ABSENT, "unresolvable", "absent"],
    ["unresolvable", present("postgresql"), "unresolvable", "running"],
    ["unresolvable", UNRESOLVABLE, "unresolvable", "unresolvable"],
  ] as const)("verdict %s with presence %j is %s", (status, presence, expected, presenceName) => {
    const combined = combineMigrationRestart(verdict(status), presence, "postgresql");
    expect(combined.class).toBe(expected);
    expect(combined.restart).toEqual({ answer: status, presence: presenceName });
    expect(combined.evidence).toEqual({ selectedBackend: "postgresql", restartCheckReason: verdict(status).reason });
  });
});

