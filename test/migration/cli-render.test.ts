import { describe, expect, it } from "vitest";
import {
  renderMigrationPlanEnvelope,
  renderMigrationDryRunEnvelope,
  renderMigrationApplyEnvelope,
  renderMigrationAbortEnvelope,
  renderMigrationVerifyEnvelope,
  renderMigrationResumeEnvelope,
  renderMigrationReportEnvelope,
  renderMigrationActivateEnvelope,
  renderMigrationRollbackEnvelope,
  renderMigrationUnexpectedFailureEnvelope,
} from "../../src/migration/cli-render.js";
import { migrationExitClassForName } from "../../src/migration/exit-classes.js";
import type { SqliteSnapshotDryRun } from "../../src/migration/sqlite-snapshot.js";

const DRY_RUN_FIXTURE: SqliteSnapshotDryRun = {
  sourceSelectionSha256: "a".repeat(64),
  sourceByteWitnessSha256: "b".repeat(64),
  checksumSha256: "c".repeat(64),
  roles: [{ role: "project" } as never, { role: "passive-events" } as never],
  inspectedAt: "2026-01-01T00:00:00.000Z",
};

describe("renderMigrationPlanEnvelope", () => {
  it("builds an ok envelope for a fresh candidate with a present daemon, carrying its observed backend", () => {
    const envelope = renderMigrationPlanEnvelope({
      status: "ok", generationId: "gen-1", disposition: "fresh",
      daemonPresence: { status: "present", storageBackend: "postgresql", pid: 1, daemonInstanceId: "d1" },
    });
    expect(envelope.outcome).toBe("ok");
    expect(envelope.exitCode).toBe(0);
    expect(envelope.applied).toBe(false);
    expect(envelope.generation).toBe("gen-1");
    expect(envelope.next).toBe("apply");
    expect(envelope.evidence).toEqual({
      disposition: "fresh", daemonPresent: true, daemonStorageBackend: "postgresql",
    });
    expect(envelope.refusal).toBeNull();
  });

  it("builds an ok envelope for an authoritatively-absent daemon, carrying daemonPresent: false and no storageBackend field (red: a boolean-collapsed presence could not tell this apart from a real error)", () => {
    const envelope = renderMigrationPlanEnvelope({
      status: "ok", generationId: "gen-2", disposition: "continue-held",
      daemonPresence: { status: "authoritatively-absent" },
    });
    expect(envelope.evidence).toEqual({ disposition: "continue-held", daemonPresent: false });
    expect("daemonStorageBackend" in envelope.evidence).toBe(false);
  });

  it("builds a refusal envelope using the closed refusal-mapping table's exit class and remedy, sanitized evidence carrying the reason's own evidence detail", () => {
    const envelope = renderMigrationPlanEnvelope({
      status: "refuse", reason: "daemon-presence-unresolvable", evidence: "pidfile-live-no-answer",
    });
    expect(envelope.outcome).toBe("refused-evidence");
    expect(envelope.exitCode).toBe(migrationExitClassForName("refused-evidence").code);
    expect(envelope.applied).toBe(false);
    expect(envelope.refusal).toEqual({
      reason: "daemon-presence-unresolvable",
      remedy: "Daemon presence could not be positively established. Run `lcm daemon status`, resolve the failure, and retry.",
    });
    expect(envelope.evidence).toEqual({ detail: "pidfile-live-no-answer" });
  });

  it("builds a refusal envelope with empty evidence when the outcome carries no evidence detail", () => {
    const envelope = renderMigrationPlanEnvelope({ status: "refuse", reason: "machine-identity-unregistered" });
    expect(envelope.evidence).toEqual({});
  });

  it("throws for an unrecognised refusal reason rather than guessing a class (proves this layer never silently defaults)", () => {
    expect(() => renderMigrationPlanEnvelope({ status: "refuse", reason: "not-a-real-reason" }))
      .toThrow(/no exit-class mapping/u);
  });
});

describe("renderMigrationDryRunEnvelope", () => {
  it("builds an ok envelope with the flat dry-run evidence, never applied", () => {
    const envelope = renderMigrationDryRunEnvelope({ status: "ok", dryRun: DRY_RUN_FIXTURE });
    expect(envelope.outcome).toBe("ok");
    expect(envelope.applied).toBe(false);
    expect(envelope.evidence).toEqual({
      sourceSelectionSha256: "a".repeat(64),
      sourceByteWitnessSha256: "b".repeat(64),
      checksumSha256: "c".repeat(64),
      roleCount: 2,
      inspectedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("builds a refusal envelope for dry-run-failed", () => {
    const envelope = renderMigrationDryRunEnvelope({ status: "refuse", reason: "dry-run-failed", evidence: "unsupported-platform" });
    expect(envelope.refusal?.reason).toBe("dry-run-failed");
    expect(envelope.evidence).toEqual({ detail: "unsupported-platform" });
  });
});

describe("renderMigrationApplyEnvelope", () => {
  it("builds an ok envelope for a real copy, applied true, next null", () => {
    const envelope = renderMigrationApplyEnvelope({ status: "ok", generationId: "gen-1", applied: true, phase: "copied", daemonPresence: { status: "authoritatively-absent" } });
    expect(envelope.outcome).toBe("ok");
    expect(envelope.applied).toBe(true);
    expect(envelope.generation).toBe("gen-1");
    expect(envelope.manifestPhase).toBe("copied");
    expect(envelope.next).toBeNull();
  });

  it("builds an ok envelope for --dry-run, applied false, next suggests dropping --dry-run", () => {
    const envelope = renderMigrationApplyEnvelope({ status: "ok", generationId: "gen-1", applied: false, daemonPresence: { status: "authoritatively-absent" } });
    expect(envelope.applied).toBe(false);
    expect(envelope.manifestPhase).toBeNull();
    expect(envelope.next).toMatch(/--dry-run/u);
  });

  it("reports applied: true for a refusal after capture already durably mutated state (red: reporting false here would tell an operator nothing moved when it did)", () => {
    const envelope = renderMigrationApplyEnvelope({ status: "refuse", reason: "copy-failed", evidence: "PostgreSqlStorageOperationError" });
    expect(envelope.applied).toBe(true);
    expect(envelope.refusal?.reason).toBe("copy-failed");
  });

  it("reports applied: true for capture-failed specifically, the other durable-mutation producer", () => {
    const envelope = renderMigrationApplyEnvelope({ status: "refuse", reason: "capture-failed" });
    expect(envelope.applied).toBe(true);
  });

  it("reports applied: false for a preflight-stage refusal before any durable mutation in this invocation (red: reporting true here would falsely claim state moved)", () => {
    const envelope = renderMigrationApplyEnvelope({ status: "refuse", reason: "machine-identity-unregistered" });
    expect(envelope.applied).toBe(false);
  });

  it("reports applied: false for a confirmation-fence refusal", () => {
    const envelope = renderMigrationApplyEnvelope({ status: "refuse", reason: "confirmation-missing" });
    expect(envelope.applied).toBe(false);
  });

  it("a refusal that says the identity step wrote reports applied: true and what it left behind, overriding the reason's own class (Codex PR #1653 P2)", () => {
    const envelope = renderMigrationApplyEnvelope({
      status: "refuse", reason: "hold-entry-contention", evidence: "lock-contention", applied: true,
      identity: { localProject: "minted", destinationProject: "created" },
    });
    expect(envelope.applied).toBe(true);
    expect(envelope.exitCode).toBe(4);
    expect(envelope.evidence).toEqual({ localProject: "minted", destinationProject: "created", detail: "lock-contention" });
  });

  it("a refusal that found the identity already present keeps the reason's class and still names what it read", () => {
    const envelope = renderMigrationApplyEnvelope({
      status: "refuse", reason: "hold-entry-contention", identity: { localProject: "persisted", destinationProject: "exists" },
    });
    expect(envelope.applied).toBe(false);
    expect(envelope.evidence).toEqual({ localProject: "persisted", destinationProject: "exists" });
  });
});

describe("renderMigrationApplyEnvelope, applied and presence evidence (round-1 A-2/B-6, A-8)", () => {
  it.each([
    "hold-entry-readback-mismatch", "capture-failed", "capture-contention", "capture-unresolvable",
    "snapshot-unresolvable", "capture-incomplete", "manifest-unresolvable",
    "genesis-inspection-failed", "genesis-create-failed", "genesis-dry-run-begin-failed",
    "genesis-dry-run-complete-failed", "copy-failed",
  ])("reports applied:true for %s, which follows a durable write in the same invocation", (reason) => {
    expect(renderMigrationApplyEnvelope({ status: "refuse", reason }).applied).toBe(true);
  });

  it.each([
    "confirmation-missing", "confirmation-generation-moved", "hold-entry-contention", "hold-entry-slot-occupied",
    "hold-entry-precondition", "hold-entry-evidence", "entering-recovery-contention", "continuation-mismatched-hold",
    "continuation-partial-snapshot", "journal-unresolvable", "publication-occupies-slot",
  ])("reports applied:false for %s, which is raised before this invocation writes anything", (reason) => {
    expect(renderMigrationApplyEnvelope({ status: "refuse", reason }).applied).toBe(false);
  });

  it("records a present daemon and its backend in the exit-0 evidence, as plan does", () => {
    const envelope = renderMigrationApplyEnvelope({
      status: "ok", generationId: "g", applied: true, phase: "copied",
      daemonPresence: { status: "present", storageBackend: "postgresql", pid: 7, daemonInstanceId: "d1" },
    });
    expect(envelope.evidence).toEqual({ daemonPresent: true, daemonStorageBackend: "postgresql" });
  });

  it("records an authoritative absence as daemonPresent:false with no backend field", () => {
    const envelope = renderMigrationApplyEnvelope({
      status: "ok", generationId: "g", applied: false, daemonPresence: { status: "authoritatively-absent" },
    });
    expect(envelope.evidence).toEqual({ daemonPresent: false });
  });
});

describe("renderMigrationUnexpectedFailureEnvelope (round-1 B-4)", () => {
  it.each([["plan", false], ["dry-run", false], ["report", false], ["apply", true], ["abort", true], ["activate", true], ["rollback", true], ["resume", true], ["verify", true]] as const)(
    "builds the closed exit-5 envelope for %s, with applied:%s and only the error name as evidence",
    (command, applied) => {
      const envelope = renderMigrationUnexpectedFailureEnvelope(command, new RangeError("a message with /a/path"));
      expect(envelope).toMatchObject({ command, outcome: "refused-evidence", exitCode: 5, applied });
      expect(envelope.refusal?.reason).toBe("unexpected-failure");
      expect(envelope.evidence).toEqual({ detail: "RangeError" });
    },
  );
});

describe("renderMigrationAbortEnvelope", () => {
  it("builds an ok envelope whose applied flag is the operation's own report of whether it wrote", () => {
    const envelope = renderMigrationAbortEnvelope({
      status: "ok", generationId: "gen-1", journalPhase: "maintenance-aborted", manifestPhase: "aborted", applied: true,
    });
    expect(envelope.applied).toBe(true);
    expect(renderMigrationAbortEnvelope({
      status: "ok", generationId: "gen-1", journalPhase: "maintenance-held", manifestPhase: null, applied: false,
    }).applied).toBe(false);
    expect(envelope.generation).toBe("gen-1");
    expect(envelope.manifestPhase).toBe("aborted");
    expect(envelope.evidence).toEqual({ journalPhase: "maintenance-aborted" });
  });

  it("builds an ok envelope with a null manifestPhase when the manifest was genuinely never created", () => {
    const envelope = renderMigrationAbortEnvelope({
      status: "ok", generationId: "gen-1", journalPhase: "maintenance-aborted", manifestPhase: null, applied: true,
    });
    expect(envelope.manifestPhase).toBeNull();
  });

  it("reports applied:true on a refusal that followed a durable write, in each direction independently (A-2)", () => {
    const after = renderMigrationAbortEnvelope({ status: "refuse", reason: "abort-unresolvable", evidence: "manifest-unexpected-state", applied: true });
    const before = renderMigrationAbortEnvelope({ status: "refuse", reason: "abort-unresolvable", evidence: "manifest-unexpected-state" });
    expect(after.applied).toBe(true);
    expect(before.applied).toBe(false);
  });

  it("carries the live generation on a confirmation refusal so the operator learns what to confirm", () => {
    const envelope = renderMigrationAbortEnvelope({ status: "refuse", reason: "abort-confirmation-moved", generationId: "gen-live" });
    expect(envelope.generation).toBe("gen-live");
    expect(envelope.exitCode).toBe(3);
  });

  it("carries the router's next on a routed refusal", () => {
    const envelope = renderMigrationAbortEnvelope({ status: "refuse", reason: "route-resume-required", generationId: "gen-1", next: "resume" });
    expect(envelope).toMatchObject({ exitCode: 6, outcome: "incomplete-recoverable", next: "resume", generation: "gen-1" });
  });

  it("builds a refusal envelope for abort-nothing-to-abort, never applied", () => {
    const envelope = renderMigrationAbortEnvelope({ status: "refuse", reason: "abort-nothing-to-abort" });
    expect(envelope.applied).toBe(false);
    expect(envelope.refusal?.reason).toBe("abort-nothing-to-abort");
  });
});

describe("renderMigrationVerifyEnvelope", () => {
  it("builds an ok envelope carrying the cell's evidence, the generation, the phase and next", () => {
    const envelope = renderMigrationVerifyEnvelope({
      status: "ok", generationId: "gen-1", manifestPhase: "verified", applied: true, next: "report",
      evidence: { reportSha256: "a".repeat(64), activationEligible: true, cell: 23, coordinationEffects: "none" },
    });
    expect(envelope).toMatchObject({
      command: "verify", outcome: "ok", exitCode: 0, generation: "gen-1", manifestPhase: "verified", applied: true, next: "report",
      evidence: { activationEligible: true, cell: 23, coordinationEffects: "none", reportSha256: "a".repeat(64) },
      refusal: null,
    });
  });

  it("builds a not-applied ok envelope for a read-only answer", () => {
    expect(renderMigrationVerifyEnvelope({
      status: "ok", generationId: "gen-1", manifestPhase: "copied", applied: false, next: null, evidence: { predictive: false },
    })).toMatchObject({ applied: false, next: null, evidence: { predictive: false } });
  });

  it.each([
    ["verify-contention", 4, undefined],
    ["verify-not-eligible", 5, undefined],
    ["verify-destination-drift", 5, undefined],
    ["existing-confirmation-moved", 3, undefined],
    ["route-not-owner", 2, "resume"],
    ["route-resume-required", 6, "resume"],
  ])("maps the refusal %s to exit %i and carries the router's next (%s) and the generation", (reason, exit, next) => {
    const envelope = renderMigrationVerifyEnvelope({ status: "refuse", reason, generationId: "gen-1", ...(next === undefined ? {} : { next }) });
    expect(envelope.exitCode).toBe(exit);
    expect(envelope.generation).toBe("gen-1");
    expect(envelope.next).toBe(next ?? null);
    expect(envelope.applied).toBe(false);
  });

  it("reports applied:true on a refusal that followed a durable write", () => {
    expect(renderMigrationVerifyEnvelope({ status: "refuse", reason: "verify-readback-mismatch", applied: true }).applied).toBe(true);
  });
});

describe("renderMigrationResumeEnvelope", () => {
  it("builds an ok envelope for a completed cell", () => {
    expect(renderMigrationResumeEnvelope({
      status: "ok", generationId: "gen-1", manifestPhase: "dry-run-verified", applied: true, next: "resume", evidence: { cell: 19 },
    })).toMatchObject({ command: "resume", outcome: "ok", exitCode: 0, generation: "gen-1", manifestPhase: "dry-run-verified", applied: true, next: "resume", evidence: { cell: 19 } });
  });

  it("builds a route-only dry-run envelope that is not applied and predicts nothing", () => {
    const envelope = renderMigrationResumeEnvelope({
      status: "ok", generationId: "gen-1", manifestPhase: "planned", applied: false, next: "resume (drop --dry-run to run this cell)",
      evidence: { cell: 19, primary: "resume", predictive: false, coordinationEffects: "none" },
    });
    expect(envelope).toMatchObject({ exitCode: 0, applied: false, evidence: { predictive: false, coordinationEffects: "none" } });
  });

  it.each([
    ["genesis-dry-run-effect-mismatch", 5],
    ["genesis-dry-run-unexpected-state", 2],
    ["resume-readback-mismatch", 5],
    ["copy-failed", 7],
  ])("maps the refusal %s to exit %i and carries the generation and next", (reason, exit) => {
    const envelope = renderMigrationResumeEnvelope({ status: "refuse", reason, generationId: "gen-1", next: "activate" });
    expect(envelope).toMatchObject({ exitCode: exit, generation: "gen-1", next: "activate", applied: false });
  });

  it("reports applied on a refusal that followed a write", () => {
    expect(renderMigrationResumeEnvelope({ status: "refuse", reason: "copy-failed", applied: true }).applied).toBe(true);
  });
});

describe("renderMigrationReportEnvelope", () => {
  const base = { generationId: "gen-1", manifestPhase: "copied", next: "verify", evidence: { cell: 22, snapshot: "complete" }, restart: null } as const;

  it("builds an ok envelope that is never applied and carries every section it read", () => {
    expect(renderMigrationReportEnvelope(base)).toMatchObject({
      command: "report", outcome: "ok", exitCode: 0, applied: false, generation: "gen-1", manifestPhase: "copied", next: "verify",
      evidence: { cell: 22, snapshot: "complete" }, refusal: null, restart: null,
    });
  });

  it("carries the restart observations on an ok envelope", () => {
    expect(renderMigrationReportEnvelope({ ...base, restart: { answer: "satisfied", presence: "absent" } }).restart)
      .toEqual({ answer: "satisfied", presence: "absent" });
  });

  it("exits 8 when only a restart is outstanding, still printing the sections and both observations", () => {
    const envelope = renderMigrationReportEnvelope({ ...base, reason: "report-restart-required", restart: { answer: "unsatisfied", presence: "running" } });
    expect(envelope).toMatchObject({
      outcome: "restart-required", exitCode: 8, applied: false, evidence: { cell: 22 },
      refusal: { reason: "report-restart-required" }, restart: { answer: "unsatisfied", presence: "running" },
    });
  });

  it.each([
    ["generation-required", 2],
    ["route-publication-in-flight", 4],
    ["route-contradiction", 5],
    ["report-restart-contradiction", 5],
    ["report-restart-unresolvable", 5],
    ["report-selection-unresolvable", 5],
  ])("maps the refusal %s to exit %i", (reason, exit) => {
    expect(renderMigrationReportEnvelope({ ...base, reason }).exitCode).toBe(exit);
  });

  it("carries a resolver refusal's detail beside the sections", () => {
    const envelope = renderMigrationReportEnvelope({
      reason: "journal-unresolvable", generationId: null, manifestPhase: null, next: null, restart: null, evidence: { detail: "journal-checksum-mismatch" },
    });
    expect(envelope).toMatchObject({ exitCode: 5, generation: null, evidence: { detail: "journal-checksum-mismatch" } });
  });
});

describe("every command's ok and refusal envelopes keep outcome/exitCode agreement (buildMigrationEnvelope's own construction-time assertion, exercised through every render function)", () => {
  it("agrees for every render function's ok path", () => {
    for (const envelope of [
      renderMigrationPlanEnvelope({ status: "ok", generationId: "g", disposition: "fresh", daemonPresence: { status: "authoritatively-absent" } }),
      renderMigrationDryRunEnvelope({ status: "ok", dryRun: DRY_RUN_FIXTURE }),
      renderMigrationApplyEnvelope({ status: "ok", generationId: "g", applied: true, phase: "copied", daemonPresence: { status: "authoritatively-absent" } }),
      renderMigrationAbortEnvelope({ status: "ok", generationId: "g", journalPhase: "maintenance-aborted", manifestPhase: null, applied: true }),
    ]) {
      expect(migrationExitClassForName(envelope.outcome).code).toBe(envelope.exitCode);
    }
  });
});


describe("renderMigrationActivateEnvelope (and the cutover renderer rollback shares)", () => {
  it("builds an ok envelope that carries the applied flag, the next step, the evidence and the restart observation", () => {
    expect(renderMigrationActivateEnvelope({
      status: "ok", generationId: "gen-1", manifestPhase: "active", applied: true, next: "revoke-transfer-grants-then-start-daemon",
      evidence: { transferGrantRevocation: "required-before-daemon-start" }, restart: { answer: "satisfied", presence: "absent" },
    })).toMatchObject({
      command: "activate", outcome: "ok", exitCode: 0, generation: "gen-1", manifestPhase: "active", applied: true,
      next: "revoke-transfer-grants-then-start-daemon", evidence: { transferGrantRevocation: "required-before-daemon-start" }, restart: { answer: "satisfied", presence: "absent" },
    });
  });

  it("builds an ok envelope with no restart observation when none is given", () => {
    expect(renderMigrationRollbackEnvelope({ status: "ok", generationId: "gen-1", manifestPhase: "rolled-back", applied: false, next: null, evidence: {} }))
      .toMatchObject({ command: "rollback", exitCode: 0, restart: null, applied: false });
  });

  it.each([
    ["backend-confirmation-missing", 3],
    ["backend-confirmation-moved", 3],
    ["activation-refused-precondition", 2],
    ["activation-refused-contention", 4],
    ["activation-refused-evidence", 5],
    ["activation-refused-resume", 6],
    ["activation-not-begun", 2],
    ["activation-interrupted", 6],
    ["activation-publication-failed", 5],
    ["activation-post-publication-unhealthy", 5],
    ["activation-identity-mismatch", 5],
    ["activation-readback-mismatch", 5],
    ["activation-invalid-input", 5],
    ["activation-unexpected-state", 5],
    ["activation-dry-run-not-predictive", 5],
    ["cutover-restart-required", 8],
    ["rollback-refused-precondition", 2],
    ["rollback-contention", 4],
    ["rollback-refused-evidence", 5],
    ["rollback-abandoned", 2],
    ["rollback-readback-mismatch", 5],
    ["rollback-dry-run-not-predictive", 5],
    ["cutover-restart-contradiction", 5],
    ["cutover-restart-unresolvable", 5],
  ])("maps the refusal %s to exit %i", (reason, exit) => {
    expect(renderMigrationActivateEnvelope({ status: "refuse", reason, generationId: "gen-1" })).toMatchObject({
      command: "activate", exitCode: exit, generation: "gen-1", applied: false, restart: null, refusal: { reason },
    });
  });

  it("keeps every section the command read, the restart observation, the next action and the applied flag on a refusal", () => {
    const envelope = renderMigrationActivateEnvelope({
      status: "refuse", reason: "cutover-restart-required", generationId: "gen-1", applied: true, next: "revoke-transfer-grants-then-start-daemon",
      evidence: "manifest-active", sections: { cell: 10, selectedBackend: "postgresql" }, restart: { answer: "unsatisfied", presence: "running" },
    });
    expect(envelope).toMatchObject({
      exitCode: 8, applied: true, next: "revoke-transfer-grants-then-start-daemon",
      evidence: { cell: 10, selectedBackend: "postgresql", detail: "manifest-active" }, restart: { answer: "unsatisfied", presence: "running" },
    });
  });
});

