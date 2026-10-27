import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  exit: vi.fn((code) => {
    throw new Error("exit:" + (code ?? 0));
  }),
  plan: vi.fn(),
  dryRun: vi.fn(),
  apply: vi.fn(),
  abort: vi.fn(),
  resume: vi.fn(),
  verify: vi.fn(),
  report: vi.fn(),
  activate: vi.fn(),
  rollback: vi.fn(),
  setPlan: vi.fn(),
  setDryRun: vi.fn(),
  setApply: vi.fn(),
  setResume: vi.fn(),
  setVerify: vi.fn(),
  setReport: vi.fn(),
  setAbort: vi.fn(),
  setActivate: vi.fn(),
  setRollback: vi.fn(),
}));

vi.mock("node:process", async (importOriginal) => ({
  ...(await importOriginal()),
  exit: state.exit,
}));

vi.mock("../../src/runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal()),
  migrateLegacyHomeIfNeeded: vi.fn(),
}));

vi.mock("../../src/migration/cli-plan.js", () => ({
  performMigrationPlan: state.plan,
}));

vi.mock("../../src/migration/cli-dry-run.js", async (importOriginal) => ({
  ...(await importOriginal()),
  performMigrationDryRunCheck: state.dryRun,
}));

vi.mock("../../src/migration/cli-apply.js", async (importOriginal) => ({
  ...(await importOriginal()),
  performMigrationApply: state.apply,
}));

vi.mock("../../src/migration/cli-abort.js", () => ({
  performMigrationAbortCommand: state.abort,
}));

vi.mock("../../src/migration/cli-resume.js", () => ({
  performMigrationResumeCommand: state.resume,
}));

vi.mock("../../src/migration/cli-verify.js", () => ({
  performMigrationVerifyCommand: state.verify,
}));

vi.mock("../../src/migration/cli-report.js", () => ({
  performMigrationReportCommand: state.report,
}));

vi.mock("../../src/migration/cli-activate.js", () => ({
  performMigrationActivateCommand: state.activate,
}));

vi.mock("../../src/migration/cli-rollback.js", () => ({
  performMigrationRollbackCommand: state.rollback,
}));

vi.mock("../../src/migration/cli-cutover-set.js", () => ({
  performSetPlan: state.setPlan,
  performSetDryRun: state.setDryRun,
  performSetApply: state.setApply,
  performSetResume: state.setResume,
  performSetVerify: state.setVerify,
  performSetReport: state.setReport,
  performSetAbort: state.setAbort,
  performSetActivate: state.setActivate,
  performSetRollback: state.setRollback,
}));

const { runCli } = await import("../../bin/lcm.js");
const { LEGACY_LCM_HOME_DIRNAME, migrateLegacyHomeIfNeeded } = await import("../../src/runtime-paths.js");

function stdoutText(spy) {
  return spy.mock.calls.map(([value]) => String(value)).join("");
}

function stderrText(spy) {
  return spy.mock.calls.map(([value]) => String(value)).join("");
}

async function invoke(...args) {
  await runCli(["node", "lcm", ...args]);
}

describe("lcm migration command group", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("plan: human mode prints a one-line ok summary and sets exitCode 0", async () => {
    state.plan.mockResolvedValueOnce({
      status: "ok", generationId: "gen-1", disposition: "fresh",
      daemonPresence: { status: "authoritatively-absent" },
    });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "plan");
    expect(state.plan).toHaveBeenCalledWith({ cwd: process.cwd(), homeDir: expect.any(String) });
    expect(stdoutText(out)).toContain("plan: ok (exit 0)");
    expect(stdoutText(out)).toContain("generation=gen-1");
    expect(stdoutText(out)).toContain("applied=false");
    expect(stdoutText(out)).toContain("next=apply");
    expect(process.exitCode).toBe(0);
  });

  it("plan --json: stdout carries exactly the envelope document, nothing else", async () => {
    state.plan.mockResolvedValueOnce({
      status: "ok", generationId: "gen-1", disposition: "fresh",
      daemonPresence: { status: "present", storageBackend: "sqlite", pid: 1, daemonInstanceId: "d1" },
    });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "plan", "--json");
    const envelope = JSON.parse(stdoutText(out));
    expect(envelope).toMatchObject({
      schemaVersion: 1, command: "plan", outcome: "ok", exitCode: 0,
      generation: "gen-1", applied: false, next: "apply",
    });
    expect(envelope.evidence).toEqual({ disposition: "fresh", daemonPresent: true, daemonStorageBackend: "sqlite" });
    expect(out.mock.calls).toHaveLength(1);
  });

  it("plan: a refusal maps through the closed refusal table to a non-zero exitCode and a human refusal line", async () => {
    state.plan.mockResolvedValueOnce({ status: "refuse", reason: "machine-identity-unregistered" });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "plan");
    expect(stdoutText(out)).toContain("Refused (refused-precondition, exit 2): machine-identity-unregistered");
    expect(stdoutText(out)).toContain("lcm machine register");
    expect(process.exitCode).toBe(2);
  });

  it("plan: an unrecognised refusal reason is never given a guessed exit code: exactly one unexpected-failure envelope is printed (round-1 B-4)", async () => {
    state.plan.mockResolvedValueOnce({ status: "refuse", reason: "not-a-real-reason" });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "plan", "--json");
    expect(out).toHaveBeenCalledTimes(1);
    const envelope = JSON.parse(stdoutText(out));
    expect(envelope).toMatchObject({ command: "plan", outcome: "refused-evidence", exitCode: 5, applied: false });
    expect(envelope.refusal.reason).toBe("unexpected-failure");
    expect(envelope.evidence).toEqual({ detail: "Error" });
    expect(process.exitCode).toBe(5);
  });

  it.each([
    ["plan", () => state.plan, false],
    ["dry-run", () => state.dryRun, false],
    ["apply", () => state.apply, true],
    ["abort", () => state.abort, true],
  ])("%s: evidence the sanitizer refuses to emit still yields exactly one envelope, without the offending value", async (command, mock, applied) => {
    mock().mockResolvedValueOnce({ status: "refuse", reason: "dry-run-failed", evidence: "/home/someone/secret/path" });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await invoke("migration", command, "--json");
    expect(out).toHaveBeenCalledTimes(1);
    const text = stdoutText(out);
    expect(text).not.toContain("/home/someone");
    expect(stderrText(err)).not.toContain("/home/someone");
    expect(JSON.parse(text)).toMatchObject({ command, exitCode: 5, applied });
    expect(JSON.parse(text).refusal.reason).toBe("unexpected-failure");
  });

  it("dry-run: ok envelope carries the flat dry-run evidence", async () => {
    state.dryRun.mockResolvedValueOnce({
      status: "ok",
      dryRun: {
        sourceSelectionSha256: "a".repeat(64), sourceByteWitnessSha256: "b".repeat(64),
        checksumSha256: "c".repeat(64), roles: [{ role: "project" }], inspectedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "dry-run", "--json");
    const envelope = JSON.parse(stdoutText(out));
    expect(envelope.command).toBe("dry-run");
    expect(envelope.applied).toBe(false);
    expect(envelope.evidence.roleCount).toBe(1);
  });

  it("dry-run: human mode prints a one-line ok summary that omits generation= entirely (dry-run never resolves a generation, so migrationHumanSummary's generation !== null branch must be provably false here, not merely untested)", async () => {
    state.dryRun.mockResolvedValueOnce({
      status: "ok",
      dryRun: {
        sourceSelectionSha256: "a".repeat(64), sourceByteWitnessSha256: "b".repeat(64),
        checksumSha256: "c".repeat(64), roles: [{ role: "project" }], inspectedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "dry-run");
    const line = stdoutText(out);
    expect(line).toBe("dry-run: ok (exit 0) applied=false\n");
    expect(line).not.toContain("generation=");
    expect(line).not.toContain("phase=");
    expect(line).not.toContain("next=");
    expect(process.exitCode).toBe(0);
  });

  it("dry-run: a refusal reports exit 5 (refused-evidence) with the dry-run-failed remedy", async () => {
    state.dryRun.mockResolvedValueOnce({ status: "refuse", reason: "dry-run-failed", evidence: "unsupported-platform" });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "dry-run");
    expect(process.exitCode).toBe(5);
    expect(stdoutText(out)).toContain("dry-run-failed");
  });

  it("apply: passes --confirm-generation, --max-records and --max-bytes through as parsed values, and succeeds", async () => {
    state.apply.mockResolvedValueOnce({ status: "ok", generationId: "gen-1", applied: true, phase: "copied", daemonPresence: { status: "authoritatively-absent" } });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "apply", "--confirm-generation", "gen-1", "--max-records", "250", "--max-bytes", "4096");
    expect(state.apply).toHaveBeenCalledWith(expect.objectContaining({
      confirmGenerationId: "gen-1", maxRecords: 250, maxBytes: 4096, dryRun: undefined,
    }));
    expect(stdoutText(out)).toContain("generation=gen-1");
    expect(stdoutText(out)).toContain("phase=copied");
    expect(process.exitCode).toBe(0);
  });

  it("apply: wires onDaemonObserved to one stderr line (never stdout) naming the observed daemon (round-1 A-8)", async () => {
    state.apply.mockImplementationOnce(async (applyInput: { onDaemonObserved: (presence: unknown) => void }) => {
      applyInput.onDaemonObserved({ status: "present", storageBackend: "postgresql", pid: 4242, daemonInstanceId: "d1" });
      return { status: "ok", generationId: "gen-1", applied: false, daemonPresence: { status: "present", storageBackend: "postgresql", pid: 4242, daemonInstanceId: "d1" } };
    });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await invoke("migration", "apply", "--confirm-generation", "gen-1", "--dry-run", "--json");
    const lines = stderrText(err).split("\n").filter((line) => line.includes("running LCM daemon"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("4242");
    expect(stdoutText(out)).not.toContain("running LCM daemon");
    expect(JSON.parse(stdoutText(out)).evidence).toEqual({ daemonPresent: true, daemonStorageBackend: "postgresql" });
  });

  it("apply: omitting --confirm-generation still reaches the orchestration layer (never a Commander-level usage error), which refuses confirmation-missing at exit 3", async () => {
    state.apply.mockResolvedValueOnce({ status: "refuse", reason: "confirmation-missing" });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "apply");
    expect(state.apply).toHaveBeenCalledWith(expect.objectContaining({ confirmGenerationId: undefined }));
    expect(process.exitCode).toBe(3);
    expect(stdoutText(out)).toContain("confirmation-missing");
  });

  it("apply --dry-run: applied false, next names dropping --dry-run", async () => {
    state.apply.mockResolvedValueOnce({ status: "ok", generationId: "gen-1", applied: false, daemonPresence: { status: "authoritatively-absent" } });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "apply", "--confirm-generation", "gen-1", "--dry-run");
    expect(state.apply).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(stdoutText(out)).toContain("applied=false");
    expect(stdoutText(out)).toContain("--dry-run");
  });

  it("apply: a non-numeric --max-records is a usage error (exit 1), never reaching the orchestration layer (red: if this reached performMigrationApply it would receive NaN rather than being refused at the boundary)", async () => {
    await expect(invoke("migration", "apply", "--confirm-generation", "gen-1", "--max-records", "not-a-number"))
      .rejects.toThrow("exit:1");
    expect(state.apply).not.toHaveBeenCalled();
  });

  it("apply: exit 7 for a mutation that already occurred (genesis/copy-stage failure), applied: true reported", async () => {
    state.apply.mockResolvedValueOnce({ status: "refuse", reason: "copy-failed", evidence: "PostgreSqlStorageOperationError" });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "apply", "--confirm-generation", "gen-1");
    expect(process.exitCode).toBe(7);
    expect(stdoutText(out)).toContain("copy-failed");
  });

  it("apply: stdout is byte-identical whether stderr progress writes actually occur or are suppressed (section 10\u0027s stream-separation proof)", async () => {
    state.apply.mockResolvedValue({ status: "ok", generationId: "gen-1", applied: true, phase: "copied", daemonPresence: { status: "authoritatively-absent" } });

    const outWithProgress = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const errWithProgress = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await invoke("migration", "apply", "--confirm-generation", "gen-1", "--json");
    const withProgress = stdoutText(outWithProgress);
    expect(stderrText(errWithProgress).length).toBeGreaterThan(0);
    vi.restoreAllMocks();

    const outSuppressed = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await invoke("migration", "apply", "--confirm-generation", "gen-1", "--json");
    const suppressed = stdoutText(outSuppressed);

    expect(suppressed).toBe(withProgress);
  });

  it("abort: ok envelope reports the operation's own applied flag", async () => {
    state.abort.mockResolvedValueOnce({
      status: "ok", generationId: "gen-1", journalPhase: "maintenance-aborted", manifestPhase: "aborted", applied: true,
    });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "abort", "--json");
    const envelope = JSON.parse(stdoutText(out));
    expect(envelope).toMatchObject({ command: "abort", applied: true, generation: "gen-1", manifestPhase: "aborted" });
  });

  it("abort: passes --confirm-generation and --dry-run through", async () => {
    state.abort.mockResolvedValueOnce({
      status: "ok", generationId: "gen-1", journalPhase: "maintenance-held", manifestPhase: null, applied: false,
    });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "abort", "--confirm-generation", "gen-1", "--dry-run", "--json");
    expect(state.abort).toHaveBeenCalledWith(expect.objectContaining({ confirmGenerationId: "gen-1", dryRun: true }));
    expect(JSON.parse(stdoutText(out))).toMatchObject({ command: "abort", applied: false });
  });

  it("abort: a confirmation refusal exits 3 and prints the live generation id even in the human summary", async () => {
    state.abort.mockResolvedValueOnce({ status: "refuse", reason: "abort-confirmation-missing", generationId: "gen-live" });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "abort");
    expect(process.exitCode).toBe(3);
    expect(stdoutText(out)).toContain("generation=gen-live");
  });

  it("abort: nothing-to-abort refuses at exit 2", async () => {
    state.abort.mockResolvedValueOnce({ status: "refuse", reason: "abort-nothing-to-abort" });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "abort");
    expect(process.exitCode).toBe(2);
    expect(stdoutText(out)).toContain("abort-nothing-to-abort");
  });

  it("bare lcm migration with no subcommand prints usage to stderr and exits 1, never calling any orchestration function", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(invoke("migration")).rejects.toThrow("exit:1");
    expect(stderrText(err)).toContain("Usage: lcm migration");
    expect(state.plan).not.toHaveBeenCalled();
    expect(state.dryRun).not.toHaveBeenCalled();
    expect(state.apply).not.toHaveBeenCalled();
    expect(state.abort).not.toHaveBeenCalled();
    expect(state.resume).not.toHaveBeenCalled();
    expect(state.verify).not.toHaveBeenCalled();
    expect(state.report).not.toHaveBeenCalled();
  });

  it("abort: passes --generation through", async () => {
    state.abort.mockResolvedValueOnce({ status: "refuse", reason: "route-resume-required", generationId: "gen-1", next: "resume" });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "abort", "--generation", "gen-1", "--confirm-generation", "gen-1", "--json");
    expect(state.abort).toHaveBeenCalledWith(expect.objectContaining({ generation: "gen-1", confirmGenerationId: "gen-1" }));
    expect(process.exitCode).toBe(6);
    expect(JSON.parse(stdoutText(out))).toMatchObject({ command: "abort", exitCode: 6, next: "resume" });
  });

  it("verify: passes --generation, --confirm-generation and --dry-run through and prints the envelope", async () => {
    state.verify.mockResolvedValueOnce({
      status: "ok", generationId: "gen-1", manifestPhase: "verified", applied: true, next: "report", evidence: { cell: 23 },
    });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "verify", "--generation", "gen-1", "--confirm-generation", "gen-1", "--dry-run", "--json");
    expect(state.verify).toHaveBeenCalledWith(expect.objectContaining({ generation: "gen-1", confirmGenerationId: "gen-1", dryRun: true }));
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdoutText(out))).toMatchObject({ command: "verify", applied: true, manifestPhase: "verified", evidence: { cell: 23 } });
  });

  it("verify: --lease-ttl-ms is passed through as a number, and a non-number is a usage error before anything runs", async () => {
    state.verify.mockResolvedValueOnce({
      status: "ok", generationId: "gen-1", manifestPhase: "verified", applied: true, next: "activate", evidence: { cell: 22 },
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "verify", "--confirm-generation", "gen-1", "--lease-ttl-ms", "1234");
    expect(state.verify).toHaveBeenCalledWith(expect.objectContaining({ leaseTtlMs: 1234, cwd: process.cwd() }));
    state.verify.mockClear();
    await expect(invoke("migration", "verify", "--lease-ttl-ms", "x")).rejects.toThrow();
    expect(state.verify).not.toHaveBeenCalled();
  });

  it("verify: the fresh path's contention refusal exits 4", async () => {
    state.verify.mockResolvedValueOnce({ status: "refuse", reason: "verify-contention", generationId: "gen-1" });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "verify", "--confirm-generation", "gen-1");
    expect(process.exitCode).toBe(4);
    expect(stdoutText(out)).toContain("verify-contention");
  });

  it("resume: passes the generation, token, dry-run and copy bounds through", async () => {
    state.resume.mockResolvedValueOnce({
      status: "ok", generationId: "gen-1", manifestPhase: "dry-run-verified", applied: true, next: "resume", evidence: { cell: 19 },
    });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "resume", "--generation", "gen-1", "--confirm-generation", "gen-1", "--max-records", "7", "--max-bytes", "99", "--json");
    expect(state.resume).toHaveBeenCalledWith(expect.objectContaining({
      generation: "gen-1", confirmGenerationId: "gen-1", maxRecords: 7, maxBytes: 99, cwd: process.cwd(),
    }));
    expect(JSON.parse(stdoutText(out))).toMatchObject({ command: "resume", applied: true, evidence: { cell: 19 } });
  });

  it("resume: --dry-run is passed through, and a non-number copy bound is a usage error before anything runs", async () => {
    state.resume.mockResolvedValueOnce({
      status: "ok", generationId: "gen-1", manifestPhase: "planned", applied: false, next: null, evidence: { predictive: false },
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "resume", "--confirm-generation", "gen-1", "--dry-run");
    expect(state.resume).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    state.resume.mockClear();
    await expect(invoke("migration", "resume", "--max-records", "x")).rejects.toThrow();
    await expect(invoke("migration", "resume", "--max-bytes", "x")).rejects.toThrow();
    expect(state.resume).not.toHaveBeenCalled();
  });

  it("report: a read report exits 0 with the sections and the restart observations in the envelope", async () => {
    state.report.mockResolvedValueOnce({
      generationId: "gen-1", manifestPhase: "copied", next: "verify", evidence: { cell: 22 }, restart: { answer: "satisfied", presence: "absent" },
    });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "report", "--generation", "gen-1", "--json");
    expect(state.report).toHaveBeenCalledWith(expect.objectContaining({ generation: "gen-1" }));
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdoutText(out))).toMatchObject({
      command: "report", applied: false, next: "verify", evidence: { cell: 22 }, restart: { answer: "satisfied", presence: "absent" },
    });
  });

  it("report: a stale running daemon exits 8 and still prints in human mode", async () => {
    state.report.mockResolvedValueOnce({
      reason: "report-restart-required", generationId: "gen-1", manifestPhase: "active", next: null, evidence: {}, restart: { answer: "unsatisfied", presence: "running" },
    });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "report");
    expect(process.exitCode).toBe(8);
    expect(stdoutText(out)).toContain("report-restart-required");
  });

  it("activate: passes the generation, both confirmations and --dry-run through, and prints the transfer-revoke next step", async () => {
    state.activate.mockResolvedValueOnce({
      status: "ok", generationId: "gen-1", manifestPhase: "active", applied: true, next: "revoke-transfer-grants-then-start-daemon",
      evidence: { transferGrantRevocation: "required-before-daemon-start" }, restart: { answer: "satisfied", presence: "absent" },
    });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "activate", "--generation", "gen-1", "--confirm-generation", "gen-1", "--confirm-backend", "postgresql", "--dry-run", "--json");
    expect(state.activate).toHaveBeenCalledWith(expect.objectContaining({
      generation: "gen-1", confirmGenerationId: "gen-1", confirmBackend: "postgresql", dryRun: true, cwd: process.cwd(),
    }));
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdoutText(out))).toMatchObject({
      command: "activate", manifestPhase: "active", next: "revoke-transfer-grants-then-start-daemon", restart: { answer: "satisfied", presence: "absent" },
    });
  });

  it("activate: a stale running daemon exits 8, an interrupted activation exits 6, and a human summary still prints the next step", async () => {
    state.activate.mockResolvedValueOnce({
      status: "refuse", reason: "cutover-restart-required", generationId: "gen-1", applied: true, next: "revoke-transfer-grants-then-start-daemon",
      restart: { answer: "unsatisfied", presence: "running" },
    });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "activate", "--confirm-generation", "gen-1", "--confirm-backend", "postgresql");
    expect(process.exitCode).toBe(8);
    expect(stdoutText(out)).toContain("cutover-restart-required");
    state.activate.mockResolvedValueOnce({ status: "refuse", reason: "activation-interrupted", generationId: "gen-1", applied: true, next: "activate" });
    await invoke("migration", "activate", "--confirm-generation", "gen-1", "--confirm-backend", "postgresql", "--json");
    expect(process.exitCode).toBe(6);
  });

  it("rollback: passes the generation, both confirmations and --dry-run through and prints the envelope", async () => {
    state.rollback.mockResolvedValueOnce({
      status: "ok", generationId: "gen-1", manifestPhase: "rolled-back", applied: true, next: "report", evidence: { rollbackMode: "pre-write" },
      restart: { answer: "satisfied", presence: "absent" },
    });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "rollback", "--generation", "gen-1", "--confirm-generation", "gen-1", "--confirm-backend", "sqlite", "--dry-run", "--json");
    expect(state.rollback).toHaveBeenCalledWith(expect.objectContaining({
      generation: "gen-1", confirmGenerationId: "gen-1", confirmBackend: "sqlite", dryRun: true,
    }));
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdoutText(out))).toMatchObject({ command: "rollback", manifestPhase: "rolled-back", restart: { answer: "satisfied", presence: "absent" } });
  });

  it("rollback: a refusal exits with its class", async () => {
    state.rollback.mockResolvedValueOnce({ status: "refuse", reason: "rollback-refused-precondition", generationId: "gen-1" });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await invoke("migration", "rollback", "--confirm-generation", "gen-1", "--confirm-backend", "sqlite");
    expect(process.exitCode).toBe(2);
    expect(stdoutText(out)).toContain("rollback-refused-precondition");
  });

  describe("--set", () => {
    const HOME = { homeDir: expect.any(String) };
    const SET = ["--generation", "set-1", "--confirm-generation", "set-1"];
    const cases: ReadonlyArray<readonly [string, readonly string[], () => ReturnType<typeof vi.fn>, object]> = [
      ["plan", [], () => state.setPlan, HOME],
      ["dry-run", [], () => state.setDryRun, HOME],
      ["apply", ["--confirm-generation", "set-1", "--dry-run", "--max-records", "5", "--max-bytes", "6"], () => state.setApply, { ...HOME, confirmGenerationId: "set-1", dryRun: true, maxRecords: 5, maxBytes: 6 }],
      ["resume", [...SET, "--dry-run", "--max-records", "7", "--max-bytes", "8"], () => state.setResume, { ...HOME, generation: "set-1", confirmGenerationId: "set-1", dryRun: true, maxRecords: 7, maxBytes: 8 }],
      ["verify", [...SET, "--dry-run"], () => state.setVerify, { ...HOME, generation: "set-1", confirmGenerationId: "set-1", dryRun: true }],
      ["report", ["--generation", "set-1"], () => state.setReport, { ...HOME, generation: "set-1" }],
      ["abort", [...SET, "--dry-run"], () => state.setAbort, { ...HOME, generation: "set-1", confirmGenerationId: "set-1", dryRun: true }],
      ["activate", [...SET, "--confirm-backend", "postgresql", "--dry-run"], () => state.setActivate, { ...HOME, generation: "set-1", confirmGenerationId: "set-1", confirmBackend: "postgresql", dryRun: true }],
      ["rollback", [...SET, "--confirm-backend", "sqlite"], () => state.setRollback, { ...HOME, generation: "set-1", confirmGenerationId: "set-1", confirmBackend: "sqlite" }],
    ];

    it.each(cases)("%s --set calls only the set adapter and prints its envelope", async (command, args, adapter, expected) => {
      adapter().mockResolvedValueOnce({
        status: "ok", generationId: "set-1", manifestPhase: "verified", applied: false, next: command + " --set", evidence: { scope: "cutover-set" },
      });
      const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await invoke("migration", command, "--set", ...args, "--json");
      expect(adapter()).toHaveBeenCalledTimes(1);
      expect(adapter()).toHaveBeenCalledWith(expect.objectContaining(expected));
      for (const single of [state.plan, state.dryRun, state.apply, state.resume, state.verify, state.report, state.abort, state.activate, state.rollback]) {
        expect(single).not.toHaveBeenCalled();
      }
      expect(out).toHaveBeenCalledTimes(1);
      expect(JSON.parse(stdoutText(out))).toMatchObject({ schemaVersion: 1, command, outcome: "ok", exitCode: 0, generation: "set-1", evidence: { scope: "cutover-set" } });
      expect(process.exitCode).toBe(0);
    });

    it("a set refusal keeps its class and the human line names the bucket", async () => {
      state.setActivate.mockResolvedValueOnce({ status: "refuse", reason: "set-refused-contention", generationId: "set-1", applied: true });
      const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await invoke("migration", "activate", "--set", ...SET, "--confirm-backend", "postgresql");
      expect(process.exitCode).toBe(4);
      expect(stdoutText(out)).toContain("Refused (refused-contention, exit 4): set-refused-contention [generation=set-1]");
    });

    it("without --set the single-generation adapters still run", async () => {
      state.report.mockResolvedValueOnce({ generationId: "gen-1", manifestPhase: "verified", next: null, evidence: {}, restart: null });
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await invoke("migration", "report", "--generation", "gen-1");
      expect(state.report).toHaveBeenCalledTimes(1);
      expect(state.setReport).not.toHaveBeenCalled();
    });

    it("rejects a verification lease option that set verification would ignore", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await expect(invoke("migration", "verify", "--set", ...SET, "--lease-ttl-ms", "100")).rejects.toThrow("exit:1");
      expect(state.setVerify).not.toHaveBeenCalled();
    });
  });

  it("lcm migration --help routes to the custom help page rather than any subcommand action", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(invoke("migration", "--help")).rejects.toThrow("exit:0");
    expect(stdoutText(out)).toContain("lcm migration <plan|dry-run|apply|resume|verify|report|abort|activate|rollback> [--json]");
    expect(state.plan).not.toHaveBeenCalled();
  });

  describe("root bootstrap (#1674)", () => {
    const legacyHome = (): string => join(homedir(), LEGACY_LCM_HOME_DIRNAME);
    const activeRoot = (): string => join(homedir(), ".lcm");
    const parkedRoot = (): string => join(homedir(), ".lcm-parked-by-test");
    const restore = (): void => {
      rmSync(legacyHome(), { recursive: true, force: true });
      if (existsSync(parkedRoot())) {
        rmSync(activeRoot(), { recursive: true, force: true });
        renameSync(parkedRoot(), activeRoot());
      }
    };
    const withoutActiveRoot = (): void => renameSync(activeRoot(), parkedRoot());
    const planOnce = async (): Promise<void> => {
      state.plan.mockResolvedValueOnce({ status: "refuse", reason: "machine-identity-unregistered" });
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await invoke("migration", "plan", "--json");
    };

    afterEach(restore);

    it.each([
      ["report", () => state.report.mockResolvedValueOnce({ generationId: "gen-1", manifestPhase: "copied", next: "verify", evidence: {}, restart: null })],
      ["plan", () => state.plan.mockResolvedValueOnce({ status: "refuse", reason: "machine-identity-unregistered" })],
      ["abort", () => state.abort.mockResolvedValueOnce({ status: "refuse", reason: "abort-nothing-to-abort" })],
    ])("runs migration %s without the legacy-home bootstrap, which a maintenance hold would refuse", async (command, arrange) => {
      arrange();
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await invoke("migration", command, "--json");
      expect(migrateLegacyHomeIfNeeded).not.toHaveBeenCalled();
    });

    it("skips the bootstrap when a finished migration left its legacy directory beside the active root", async () => {
      mkdirSync(legacyHome(), { recursive: true, mode: 0o700 });
      await planOnce();
      expect(migrateLegacyHomeIfNeeded).not.toHaveBeenCalled();
    });

    it("keeps the bootstrap while a legacy directory waits to be moved into an absent active root", async () => {
      mkdirSync(legacyHome(), { recursive: true, mode: 0o700 });
      withoutActiveRoot();
      await planOnce();
      expect(migrateLegacyHomeIfNeeded).toHaveBeenCalledTimes(1);
    });

    it("does not treat a legacy path that is not a directory as a home to move", async () => {
      writeFileSync(legacyHome(), "not a directory");
      withoutActiveRoot();
      await planOnce();
      expect(migrateLegacyHomeIfNeeded).not.toHaveBeenCalled();
    });
  });
});
