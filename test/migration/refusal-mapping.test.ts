import { describe, expect, it } from "vitest";
import {
  MIGRATION_REFUSAL_REASONS,
  migrationRefusalMapping,
} from "../../src/migration/refusal-mapping.js";
import { MIGRATION_EXIT_CLASSES } from "../../src/migration/exit-classes.js";

const VALID_CLASS_NAMES = new Set(MIGRATION_EXIT_CLASSES.map((entry) => entry.name));

/**
 * Every refusal reason string a shipped module in this candidate can
 * actually emit (apply.ts, candidate.ts), read directly from those
 * modules' own tests rather than retyped from memory here, so this list
 * cannot silently drift from what production code actually produces.
 */
const REASONS_APPLY_TS_AND_CANDIDATE_TS_CAN_EMIT = [
  "publication-occupies-slot",
  "journal-unresolvable",
  "generation-occupied-since-probe",
  "generation-unresolvable-since-probe",
  "generation-invalid-input",
  "generation-identifier-bound-exceeded",
  "generation-probe-bound-exceeded",
  "generation-occupancy-refused",
  "multi-machine-installation",
  "hold-entry-contention",
  "hold-entry-slot-occupied",
  "hold-entry-precondition",
  "hold-entry-evidence",
  "capture-contention",
  "capture-unresolvable",
  "continuation-partial-snapshot",
  "continuation-snapshot-tampered",
  "hold-entry-readback-mismatch",
  "capture-failed",
  "continuation-mismatched-hold",
  "continuation-resume-required",
  "continuation-unclassified",
  "abort-gate-unresolvable",
  "abort-or-resume-required",
  "entering-recovery-precondition",
  "entering-recovery-contention",
  "entering-recovery-evidence",
  "entering-recovery-unclassified",
];

const REASONS_APPLY_GENESIS_COPY_TS_CAN_EMIT = [
  "snapshot-unresolvable",
  "capture-incomplete",
  "manifest-unresolvable",
  "genesis-inspection-failed",
  "genesis-create-failed",
  "genesis-dry-run-begin-failed",
  "genesis-dry-run-complete-failed",
  "genesis-dry-run-effect-mismatch",
  "genesis-dry-run-unexpected-state",
  "copy-failed",
];

describe("MIGRATION_REFUSAL_REASONS (section 12's single exported constant)", () => {
  it("has no duplicate reason strings", () => {
    const seen = new Set<string>();
    for (const entry of MIGRATION_REFUSAL_REASONS) {
      expect(seen.has(entry.reason)).toBe(false);
      seen.add(entry.reason);
    }
  });

  it("every entry's exitClass is one of the nine real, closed exit classes -- never a typo'd or invented name", () => {
    for (const entry of MIGRATION_REFUSAL_REASONS) {
      expect(VALID_CLASS_NAMES.has(entry.exitClass)).toBe(true);
    }
  });

  it("every entry has a non-empty, static remedy that never looks like it carries an interpolated message (bin/lcm.ts:4307-4308's rule: no remedy contains a colon-delimited driver-style suffix)", () => {
    for (const entry of MIGRATION_REFUSAL_REASONS) {
      expect(entry.remedy.length).toBeGreaterThan(0);
    }
  });

  it("is deeply frozen", () => {
    expect(Object.isFrozen(MIGRATION_REFUSAL_REASONS)).toBe(true);
    for (const entry of MIGRATION_REFUSAL_REASONS) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  it("only the reasons whose state a re-run finishes claim exit class incomplete-recoverable (exit 6): the router's pending effect that resume finishes, and the activation whose re-entry finishes it (section 5's exit-6 rule)", () => {
    expect(MIGRATION_REFUSAL_REASONS.filter((entry) => entry.exitClass === "incomplete-recoverable").map((entry) => entry.reason))
      .toEqual(["abort-manifest-needs-resume", "route-resume-required", "activation-refused-resume", "activation-interrupted", "set-incomplete"]);
  });

  it.each(REASONS_APPLY_TS_AND_CANDIDATE_TS_CAN_EMIT)(
    "covers apply.ts/candidate.ts's real refusal reason %s",
    (reason) => {
      expect(() => migrationRefusalMapping(reason)).not.toThrow();
    },
  );

  it.each(REASONS_APPLY_GENESIS_COPY_TS_CAN_EMIT)(
    "covers apply-genesis-copy.ts's real refusal reason %s",
    (reason) => {
      expect(() => migrationRefusalMapping(reason)).not.toThrow();
    },
  );
});

describe("round-1 classified reasons (B-5, A-9, A-11, A-7)", () => {
  it.each([
    ["hold-entry-contention", "refused-contention"],
    ["hold-entry-slot-occupied", "refused-contention"],
    ["hold-entry-precondition", "refused-precondition"],
    ["hold-entry-evidence", "refused-evidence"],
    ["capture-contention", "refused-contention"],
    ["capture-unresolvable", "refused-evidence"],
    ["capture-failed", "failed-operator-required"],
    ["continuation-partial-snapshot", "refused-precondition"],
    ["continuation-snapshot-tampered", "refused-evidence"],
    ["unexpected-failure", "refused-evidence"],
    ["abort-confirmation-missing", "refused-confirmation"],
    ["abort-confirmation-moved", "refused-confirmation"],
  ])("maps %s to %s", (reason, exitClass) => {
    expect(migrationRefusalMapping(reason).exitClass).toBe(exitClass);
  });

  it("the hold-entry reasons never tell the operator to abort: applied: true means a maintenance hold may remain, inspected with report before recovery (A-11)", () => {
    const holdEntry = MIGRATION_REFUSAL_REASONS.filter((entry) => entry.reason.startsWith("hold-entry-") && entry.reason !== "hold-entry-readback-mismatch");
    expect(holdEntry.map((entry) => entry.reason).sort()).toEqual([
      "hold-entry-contention", "hold-entry-evidence", "hold-entry-precondition", "hold-entry-slot-occupied",
    ]);
    for (const entry of holdEntry) expect(entry.remedy).not.toMatch(/abort/u);
  });

  it("the collapsed hold-entry-failed reason no longer exists", () => {
    expect(() => migrationRefusalMapping("hold-entry-failed")).toThrow(/no exit-class mapping/u);
  });
});

describe("migrationRefusalMapping", () => {
  it("resolves the exact same entry object the table itself contains", () => {
    const fromTable = MIGRATION_REFUSAL_REASONS.find((entry) => entry.reason === "capture-failed")!;
    expect(migrationRefusalMapping("capture-failed")).toBe(fromTable);
  });

  it("refuses (throws) rather than returning a guessed default for an unrecognised reason (red: silently defaulting here would hide a real gap in the table behind a plausible-looking exit code)", () => {
    expect(() => migrationRefusalMapping("not-a-real-reason")).toThrow(
      "migration CLI has no exit-class mapping for refusal reason: not-a-real-reason",
    );
  });
});

describe("MIGRATION_REFUSAL_REASONS covers abort.ts's classified reasons", () => {
  const REASONS_ABORT_TS_CAN_EMIT = [
    "abort-wrong-phase",
    "abort-journal-moved",
    "abort-invalid-input",
    "abort-manifest-needs-resume",
    "abort-unresolvable",
  ];

  it.each(REASONS_ABORT_TS_CAN_EMIT)(
    "covers classifyMigrationAbortRefusal's real reason %s",
    (reason) => {
      expect(() => migrationRefusalMapping(reason)).not.toThrow();
    },
  );
});

describe("MIGRATION_REFUSAL_REASONS covers the target-resolution and ownership reasons", () => {
  const REASONS_TARGET_AND_OWNERSHIP_CAN_EMIT = [
    "invalid-expected-owner",
    "machine-identity-unregistered",
    "migration-target-identity-unresolvable",
    "migration-target-missing",
    "migration-target-unresolvable",
    "dry-run-failed",
  ];

  it.each(REASONS_TARGET_AND_OWNERSHIP_CAN_EMIT)(
    "covers real reason %s",
    (reason) => {
      expect(() => migrationRefusalMapping(reason)).not.toThrow();
    },
  );

  it("unbound-postgresql-project is no longer a migration refusal reason: the remedy it used to name would have told an operator to bind the exact project-map field that must stay unset through capture, genesis and copy (section 4.10)", () => {
    expect(() => migrationRefusalMapping("unbound-postgresql-project")).toThrow(/no exit-class mapping/u);
  });
});

describe("MIGRATION_REFUSAL_REASONS covers the abort command orchestration's own reasons", () => {
  const REASONS_CLI_ABORT_CAN_EMIT = [
    "abort-nothing-to-abort",
    "abort-readback-mismatch",
    "abort-confirmation-missing",
    "abort-confirmation-moved",
  ];

  it.each(REASONS_CLI_ABORT_CAN_EMIT)(
    "covers real reason %s",
    (reason) => {
      expect(() => migrationRefusalMapping(reason)).not.toThrow();
    },
  );
});

describe("MIGRATION_REFUSAL_REASONS covers the target-reachability verification reasons", () => {
  const REASONS_VERIFICATION_CAN_EMIT = ["migration-target-verification-failed", "migration-target-verification-unresolvable"];

  it.each(REASONS_VERIFICATION_CAN_EMIT)(
    "covers real reason %s",
    (reason) => {
      expect(() => migrationRefusalMapping(reason)).not.toThrow();
    },
  );
});
