import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  performMigrationReportCommand,
  type MigrationReportCommandOperations,
} from "../../src/migration/cli-report.js";
import { MIGRATION_MISMATCH_CLASSES, MIGRATION_PUBLIC_PROBE_ORDER } from "../../src/migration/verification-report.js";
import { resolveExistingMigrationGeneration } from "../../src/migration/existing-generation.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import type { ActivationRestartCheckResult } from "../../src/migration/activation-restart-check.js";
import type { MigrationDaemonPresence } from "../../src/migration/daemon-presence.js";
import {
  withBackendPublicationAppendBarrierAsync,
  type BackendMaintenanceJournal,
} from "../../src/storage/backend-publication.js";
import {
  abortedFixtureJournal,
  createFixtureManifest,
  FIXTURE_GENERATION,
  fixtureVerificationReport,
  FIXTURE_MACHINE_ID,
  heldFixtureJournal,
  maintenanceCoordinator,
  makeFixtureHome,
  persistFixtureReport,
  removeFixtureHomes,
  snapshotHome,
} from "./existing-fixtures.js";

const roots: string[] = [];
afterEach(() => removeFixtureHomes(roots));

const complete = async () => ({ state: "complete" as const, witness: {} as never });
const resolution = { _operationsForTesting: { classifySnapshot: complete } };

function verdict(status: ActivationRestartCheckResult["status"]): ActivationRestartCheckResult {
  return { status, reason: status === "satisfied" ? "backend-matches" : status === "unsatisfied" ? "backend-stale" : "health-unreachable", detail: "x", pid: 7, observedBackend: null, selectedBackend: "sqlite" };
}
const present = (storageBackend: string): MigrationDaemonPresence => ({ status: "present", storageBackend, pid: 7, daemonInstanceId: "d" });
const ABSENT: MigrationDaemonPresence = { status: "authoritatively-absent" };
const UNRESOLVABLE: MigrationDaemonPresence = { status: "unresolvable", evidence: "pidfile-live-no-answer" };

function restartOps(check: ActivationRestartCheckResult, presence: MigrationDaemonPresence): Partial<MigrationReportCommandOperations> {
  return { checkRestart: async () => check, classifyPresence: async () => presence, readDaemonPort: () => 1234 };
}

describe("report: a read-only account of one generation", () => {
  it("reads a held, planned generation: sections, the router's next action, no restart, and nothing written", async () => {
    const home = makeFixtureHome(roots);
    const journal = await heldFixtureJournal(home);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "planned");
    const before = snapshotHome(home);
    const checkRestart = vi.fn();
    const result = await performMigrationReportCommand({ homeDir: home, _resolution: resolution, _operationsForTesting: { checkRestart } });
    expect(result).toEqual({
      generationId: FIXTURE_GENERATION, manifestPhase: "planned", next: "resume", restart: null,
      evidence: {
        journalKind: "hold", journalPhase: "maintenance-held", journalGeneration: journal.generationId,
        snapshot: "complete", manifestPresent: true, manifestRevision: 0, recovery: "ready", pendingEffect: null, activationEligible: false,
        verificationReport: "absent", cell: 19, primary: "resume", allowed: "abort", selectedBackend: null,
        activationLink: "absent", activationReport: "none", generationBinding: "absent", rollbackEvidence: "absent",
        rollbackReport: "none", rollbackAuthority: "absent",
      },
    });
    expect(checkRestart).not.toHaveBeenCalled();
    expect(snapshotHome(home)).toEqual(before);
  });

  it("acquires nothing: it completes while the consumer lock and the append barrier are held elsewhere, and writes nothing", async () => {
    const home = makeFixtureHome(roots);
    await abortedFixtureJournal(home);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "copied");
    const before = snapshotHome(home);
    // The append barrier holds the publication lock; a command that tried to
    // take either would wait out its deadline here. A terminal journal admits
    // the holder.
    const result = await withBackendPublicationAppendBarrierAsync(home, () =>
      performMigrationReportCommand({ homeDir: home, _resolution: resolution }));
    expect(result.reason).toBeUndefined();
    expect(result.next).toBe("abort");
    expect(snapshotHome(home)).toEqual(before);
  });

  it("shows the verification report subset when the manifest names one", async () => {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    const report = fixtureVerificationReport();
    persistFixtureReport(home, report);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "verified", { report });
    const result = await performMigrationReportCommand({ homeDir: home, _resolution: resolution });
    expect(result.evidence).toMatchObject({
      verificationReport: "present", verificationReportSha256: report.reportSha256, verificationClean: true,
      verificationActivationEligible: true, verificationMismatchTotal: 0,
      verificationClassCoverageComplete: true, verificationPublicProbeCoverageComplete: true,
      cell: 24, primary: "activate",
    });
    expect(result.next).toBe("activate");
  });

  it("totals a dirty report's mismatches and shows incomplete coverage", async () => {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    const dirty = fixtureVerificationReport(FIXTURE_GENERATION, {
      mismatches: [{ domain: "messages", class: "count", identitySha256: "a".repeat(64) }],
      mismatchTotals: [{ domain: "messages", class: "count", count: 3 }],
      classCoverage: MIGRATION_MISMATCH_CLASSES.map((mismatchClass, index) => ({ class: mismatchClass, ran: index !== MIGRATION_MISMATCH_CLASSES.length - 1 })),
      publicProbeCoverage: MIGRATION_PUBLIC_PROBE_ORDER.map((probe, index) => ({ probe, ran: index !== MIGRATION_PUBLIC_PROBE_ORDER.length - 1 })),
    });
    persistFixtureReport(home, dirty);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "verified", { report: dirty });
    const result = await performMigrationReportCommand({ homeDir: home, _resolution: resolution });
    expect(result.evidence).toMatchObject({
      verificationClean: false, verificationMismatchTotal: 3,
      verificationClassCoverageComplete: false, verificationPublicProbeCoverageComplete: false,
    });
  });

  it("shows a verification reference whose report cannot be read as unreadable, never as absent", async () => {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    const report = fixtureVerificationReport();
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "verified", { report });
    const result = await performMigrationReportCommand({ homeDir: home, _resolution: resolution });
    expect(result.evidence).toMatchObject({ verificationReport: "unreadable", verificationReportSha256: report.reportSha256 });
    expect(result.reason).toBe("report-evidence-unresolvable");
  });

  it("uses the terminal journal's own generation when none is named, so a report after an abort needs no flag", async () => {
    const home = makeFixtureHome(roots);
    await abortedFixtureJournal(home);
    const result = await performMigrationReportCommand({
      homeDir: home, _resolution: resolution,
      _operationsForTesting: restartOps(verdict("satisfied"), ABSENT),
    });
    expect(result).toMatchObject({ generationId: FIXTURE_GENERATION, next: "apply", evidence: { cell: 5, selectedBackend: "sqlite" } });
    expect(result.reason).toBeUndefined();
  });
});

describe("report: resolution refusals still print what they can", () => {
  it("exits on an ambiguous generation (no hold and none named)", async () => {
    const home = makeFixtureHome(roots);
    expect(await performMigrationReportCommand({ homeDir: home })).toEqual({
      reason: "generation-required", generationId: null, manifestPhase: null, next: null, restart: null, evidence: {},
    });
  });

  it("carries a journal-unresolvable refusal's evidence", async () => {
    const home = makeFixtureHome(roots);
    const result = await performMigrationReportCommand({
      homeDir: home, _resolution: { _operationsForTesting: { observeJournal: () => ({ kind: "unresolvable", evidence: "journal-checksum-mismatch" }) } },
    });
    expect(result).toMatchObject({ reason: "journal-unresolvable", evidence: { detail: "journal-checksum-mismatch" } });
  });

  it("refuses a malformed --generation", async () => {
    const home = makeFixtureHome(roots);
    expect(await performMigrationReportCommand({ homeDir: home, generation: "../x" })).toMatchObject({ reason: "generation-invalid" });
  });

  it("resolves an explicit --generation", async () => {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "planned");
    const result = await performMigrationReportCommand({ homeDir: home, generation: FIXTURE_GENERATION, _resolution: resolution });
    expect(result.generationId).toBe(FIXTURE_GENERATION);
  });
});

describe("report: rows with no owner and no way forward exit non-zero but still print the sections", () => {
  it.each([
    ["row 1 (an unresolvable journal)", { kind: "unresolvable", evidence: "journal-malformed-journal" }, "route-unresolvable"],
    ["row 2 (a foreign publication in flight)", { kind: "publication", publicationId: "p", phase: "map-publishing" }, "route-publication-in-flight"],
    ["row 3 (a foreign completed publication)", { kind: "publication", publicationId: "p", phase: "completed" }, "route-foreign-publication"],
  ])("%s", async (_name, observation, reason) => {
    const home = makeFixtureHome(roots);
    // The named generation exists (its manifest is present); only the journal is foreign.
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "copied");
    const result = await performMigrationReportCommand({
      homeDir: home, generation: FIXTURE_GENERATION,
      _resolution: { _operationsForTesting: { observeJournal: () => observation as never, classifySnapshot: complete } },
    });
    expect(result.reason).toBe(reason);
    expect(result.generationId).toBe(FIXTURE_GENERATION);
    expect(result.evidence).toMatchObject({ activationLink: "absent", generationBinding: "absent" });
  });

  it("an explicit --generation that nothing names refuses generation-unknown even while another generation holds, instead of reading that hold as this id (Codex PR #1653)", async () => {
    const home = makeFixtureHome(roots);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "copied");
    const result = await performMigrationReportCommand({
      homeDir: home, generation: "generation-typo",
      _resolution: { _operationsForTesting: { observeJournal: () => ({ kind: "hold", journal: { phase: "maintenance-held", generationId: FIXTURE_GENERATION } }) as never, classifySnapshot: complete } },
    });
    expect(result).toMatchObject({ reason: "generation-unknown", generationId: null });
  });

  it("row 9 (an aborted journal beside a manifest no abort settles) exits as a contradiction", async () => {
    const home = makeFixtureHome(roots);
    await abortedFixtureJournal(home);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "active");
    const result = await performMigrationReportCommand({
      homeDir: home, _resolution: resolution,
      _operationsForTesting: restartOps(verdict("satisfied"), ABSENT),
    });
    expect(result.reason).toBe("route-contradiction");
    expect(result.evidence).toMatchObject({ cell: 9 });
  });

  it("an aborted PostgreSQL-origin journal of another generation beside an aborted manifest is cell 9 with no next command and no sqlite selection, never cell 5", async () => {
    const home = makeFixtureHome(roots);
    const coordinator = maintenanceCoordinator(home);
    const hash = (character: string) => character.repeat(64);
    const held = await coordinator.enterMaintenance({
      publicationId: "maintenance-publication", generationId: "generation-2", sourceBackend: "postgresql",
      sourceSelectionSha256: hash("a"), queueEvidenceSha256: hash("b"),
      roster: [{ machineId: FIXTURE_MACHINE_ID, queueCutoff: null, evidenceSha256: hash("a") }],
    });
    await coordinator.abortMaintenance({
      expectedChecksumSha256: held.checksumSha256, sourceSelectionSha256: held.sourceSelectionSha256, abortEvidenceSha256: hash("c"),
    });
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "aborted");
    const result = await performMigrationReportCommand({
      homeDir: home, generation: FIXTURE_GENERATION, _resolution: resolution,
      _operationsForTesting: restartOps(verdict("satisfied"), ABSENT),
    });
    expect(result).toMatchObject({ reason: "route-contradiction", generationId: FIXTURE_GENERATION, next: null, evidence: { cell: 9, selectedBackend: null } });
  });

  it.each(["active", "rolled-back"] as const)("a foreign aborted hold beside an %s manifest is cell 9 with no selected backend and no restart check", async (phase) => {
    const home = makeFixtureHome(roots);
    await abortedFixtureJournal(home, "generation-2");
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), phase);
    const checkRestart = vi.fn(async () => verdict("satisfied"));
    const result = await performMigrationReportCommand({
      homeDir: home, generation: FIXTURE_GENERATION, _resolution: resolution,
      _operationsForTesting: { ...restartOps(verdict("satisfied"), ABSENT), checkRestart },
    });
    expect(result).toMatchObject({ reason: "route-contradiction", generationId: FIXTURE_GENERATION, next: null, evidence: { cell: 9, selectedBackend: null } });
    expect(result.restart).toBeNull();
    expect(checkRestart).not.toHaveBeenCalled();
  });

  it("row 25 (anything else) exits as a contradiction", async () => {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "copied");
    const result = await performMigrationReportCommand({
      homeDir: home, _resolution: { _operationsForTesting: { classifySnapshot: async () => ({ state: "absent" as const }) } },
    });
    expect(result.reason).toBe("route-contradiction");
    expect(result.evidence).toMatchObject({ cell: 25, snapshot: "absent" });
  });
});

describe("report: the restart matrix, with the PID evidence and the daemon backend varied independently (plan-v4 section 7)", () => {
  /** Row 5: the settled abort selects sqlite, so a durable selection exists. */
  async function selected() {
    const home = makeFixtureHome(roots);
    await abortedFixtureJournal(home);
    return home;
  }

  it.each<[string, ActivationRestartCheckResult["status"], MigrationDaemonPresence, string | undefined, string]>([
    ["satisfied, no daemon", "satisfied", ABSENT, undefined, "absent"],
    ["satisfied, daemon on the selected backend", "satisfied", present("sqlite"), undefined, "running"],
    ["satisfied by the checker but the daemon runs a stale backend", "satisfied", present("postgresql"), "report-restart-contradiction", "running"],
    ["satisfied by the checker but presence is unresolvable", "satisfied", UNRESOLVABLE, "report-restart-contradiction", "unresolvable"],
    ["unsatisfied and the daemon is stale", "unsatisfied", present("postgresql"), "report-restart-required", "running"],
    ["unsatisfied but no daemon is present", "unsatisfied", ABSENT, "report-restart-contradiction", "absent"],
    ["unsatisfied but the daemon is on the selected backend", "unsatisfied", present("sqlite"), "report-restart-contradiction", "running"],
    ["unsatisfied and presence is unresolvable", "unsatisfied", UNRESOLVABLE, "report-restart-contradiction", "unresolvable"],
    ["unresolvable with no daemon", "unresolvable", ABSENT, "report-restart-unresolvable", "absent"],
    ["unresolvable with a stale daemon", "unresolvable", present("postgresql"), "report-restart-unresolvable", "running"],
    ["unresolvable and presence unresolvable", "unresolvable", UNRESOLVABLE, "report-restart-unresolvable", "unresolvable"],
  ])("%s", async (_name, status, presence, reason, presenceName) => {
    const home = await selected();
    const result = await performMigrationReportCommand({
      homeDir: home, _resolution: resolution, _operationsForTesting: restartOps(verdict(status), presence),
    });
    expect(result.reason).toBe(reason);
    expect(result.restart).toEqual({ answer: status, presence: presenceName });
    expect(result.evidence).toMatchObject({ selectedBackend: "sqlite" });
  });

  it("fails closed when the restart check cannot be made, and when the presence observation cannot", async () => {
    const home = await selected();
    const checkFails = await performMigrationReportCommand({
      homeDir: home, _resolution: resolution,
      _operationsForTesting: { checkRestart: async () => { throw new TypeError("boom"); }, classifyPresence: async () => ABSENT, readDaemonPort: () => 1 },
    });
    expect(checkFails).toMatchObject({ reason: "report-restart-unresolvable", restart: null, evidence: { restartObservation: "TypeError", selectedBackend: "sqlite" } });
    const presenceFails = await performMigrationReportCommand({
      homeDir: home, _resolution: resolution,
      _operationsForTesting: { checkRestart: async () => verdict("satisfied"), classifyPresence: async () => { throw new RangeError("boom"); }, readDaemonPort: () => 1 },
    });
    expect(presenceFails).toMatchObject({ reason: "report-restart-unresolvable", restart: null, evidence: { restartObservation: "RangeError" } });
  });

  it("with the real checker and presence classifier, an empty home has no daemon and is satisfied", async () => {
    const home = await selected();
    // The home's own configured port must be one nothing answers on, or a daemon running on the host's default port is observed instead.
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a TCP listener");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    writeFileSync(join(home, ".lcm", "config.json"), JSON.stringify({ daemon: { port: address.port } }), { mode: 0o600 });
    const result = await performMigrationReportCommand({ homeDir: home, _resolution: resolution });
    expect(result.reason).toBeUndefined();
    expect(result.restart).toEqual({ answer: "satisfied", presence: "absent" });
  });
});

describe("report: which backend a durable selection names", () => {
  async function fabricated(overrides: { stage?: "planned" | "active" | "rolled-back"; journalPhase?: string; targetBackend?: "sqlite" | "postgresql" | null; row?: number }) {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), overrides.stage ?? "planned");
    const calls: string[] = [];
    const result = await performMigrationReportCommand({
      homeDir: home, _resolution: resolution,
      _operationsForTesting: {
        resolve: async (input) => {
          const real = await resolveExistingMigrationGeneration(input);
          if (real.status !== "resolved") return real;
          const journal = { ...(real.context.journal as { kind: "hold"; journal: BackendMaintenanceJournal }).journal };
          return {
            status: "resolved",
            context: {
              ...real.context,
              journal: { kind: "hold", journal: { ...journal, ...(overrides.journalPhase === undefined ? {} : { phase: overrides.journalPhase }), targetBackend: overrides.targetBackend ?? null } as never },
              route: { ...real.context.route, row: overrides.row ?? real.context.route.row },
            },
          };
        },
        checkRestart: async (input) => { calls.push(input.selectedBackend); return verdict("satisfied"); },
        classifyPresence: async () => ABSENT,
        readDaemonPort: () => 1,
      },
    });
    return { result, calls };
  }

  it("an active manifest selects postgresql", async () => {
    const { result, calls } = await fabricated({ stage: "active" });
    expect(calls).toEqual(["postgresql"]);
    expect(result.evidence).toMatchObject({ selectedBackend: "postgresql" });
  });

  it("a rolled-back manifest selects sqlite", async () => {
    expect((await fabricated({ stage: "rolled-back" })).calls).toEqual(["sqlite"]);
  });

  it("a selection-completed hold names its own targetBackend", async () => {
    expect((await fabricated({ journalPhase: "selection-completed", targetBackend: "postgresql" })).calls).toEqual(["postgresql"]);
  });

  it("a selection-completed hold with no targetBackend is unresolvable and the checker is not called", async () => {
    const { result, calls } = await fabricated({ journalPhase: "selection-completed", targetBackend: null });
    expect(result.reason).toBe("report-selection-unresolvable");
    expect(calls).toEqual([]);
  });

  it("any other cell has no durable selection and does not call the checker", async () => {
    const { result, calls } = await fabricated({});
    expect(calls).toEqual([]);
    expect(result.restart).toBeNull();
  });
});

describe("report: the boundary", () => {
  it("maps an unclassified throw to the closed unexpected-failure, never applied", async () => {
    const result = await performMigrationReportCommand({
      homeDir: "/tmp/none", _operationsForTesting: { resolve: async () => { throw new TypeError("boom /a/path"); } },
    });
    expect(result).toEqual({ reason: "unexpected-failure", generationId: null, manifestPhase: null, next: null, restart: null, evidence: { detail: "TypeError" } });
  });
});


describe("report: the activation and rollback readers (#625 and #626), all lock-free and three-valued", () => {
  const link = (publicationId = "pub-1") => ({
    state: "resolved" as const, path: "/ignored",
    link: { version: 1, generationId: FIXTURE_GENERATION, publicationId, identityDigest: "d".repeat(64), epochManifestRevision: 4, epochManifestChecksumSha256: "e".repeat(64) },
  }) as never;

  function activeFixture() {
    const home = makeFixtureHome(roots);
    persistFixtureReport(home, fixtureVerificationReport());
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "active");
    const observation = { kind: "publication" as const, publicationId: "pub-1", phase: "completed" as const };
    const resolutionOwn = { _operationsForTesting: { observeJournal: () => observation, classifySnapshot: complete, readLink: () => link() } };
    return { home, resolutionOwn };
  }
  const present = {
    readActivationReport: () => ({ state: "resolved", report: {}, path: "/p" }) as never,
    resolveBindings: () => ({ state: "resolved", witnesses: [{}, {}], selections: [{ kind: "activation" }, { kind: "rollback" }] }) as never,
    readActivationEvidence: () => ({ state: "resolved", epochs: [{}], attempts: [{}, {}], witnesses: [{}, {}, {}] }) as never,
    readRollbackReport: () => ({ kind: "rollback", mode: "pre-write", eligibility: "pre-write" }) as never,
    readRollbackAuthority: () => ({}) as never,
    ...restartOps(verdict("satisfied"), ABSENT),
  };

  it("shows every reader that answered: the link, the report, the bindings, the epoch store, the rollback report and the authority artifact", async () => {
    const { home, resolutionOwn } = activeFixture();
    const before = snapshotHome(home);
    const result = await performMigrationReportCommand({ homeDir: home, generation: FIXTURE_GENERATION, _resolution: resolutionOwn, _operationsForTesting: present });
    expect(result.reason).toBeUndefined();
    expect(result.evidence).toMatchObject({
      activationLink: "present", activationPublicationId: "pub-1", activationEpochManifestRevision: 4,
      activationReport: "present", activationReportSha256: "b".repeat(64),
      generationBinding: "present", witnessBindings: 2, selectionBindings: "activation,rollback",
      rollbackEvidence: "present", activationEpochs: 1, activationAttempts: 2, activationWitnesses: 3,
      rollbackReport: "none", rollbackAuthority: "present", cell: 10, selectedBackend: "postgresql",
    });
    expect(snapshotHome(home)).toEqual(before);
  });

  it("an absent store is absent, not a problem: the exit stays 0", async () => {
    const { home, resolutionOwn } = activeFixture();
    const result = await performMigrationReportCommand({
      homeDir: home, generation: FIXTURE_GENERATION, _resolution: { _operationsForTesting: { ...resolutionOwn._operationsForTesting, readLink: () => ({ state: "authoritatively-absent", detail: "x" }) as never, observeJournal: () => ({ kind: "absent" }) } },
      _operationsForTesting: {
        ...present,
        resolveBindings: () => ({ state: "authoritatively-absent" }) as never,
        readActivationEvidence: () => ({ state: "authoritatively-absent" }) as never,
        readRollbackAuthority: () => null,
      },
    });
    expect(result.evidence).toMatchObject({ activationLink: "absent", generationBinding: "absent", rollbackEvidence: "absent", rollbackAuthority: "absent" });
  });

  it("the rollback report named by the manifest is read by its id, and its kind, mode and eligibility are shown", async () => {
    const home = makeFixtureHome(roots);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "rolled-back");
    const readRollback = vi.fn(present.readRollbackReport);
    const result = await performMigrationReportCommand({
      homeDir: home, generation: FIXTURE_GENERATION, _resolution: resolution,
      _operationsForTesting: { ...present, readRollbackReport: readRollback, ...restartOps(verdict("satisfied"), ABSENT) },
    });
    expect(readRollback).toHaveBeenCalledWith(home, FIXTURE_GENERATION, "rollback-report");
    expect(result.evidence).toMatchObject({ rollbackReport: "present", rollbackReportKind: "rollback", rollbackMode: "pre-write", rollbackEligibility: "pre-write" });
  });

  it.each([
    ["the link", { activationLink: { state: "unresolvable", reason: "multi-link", detail: "x" } }, "activationLink", "unresolvable", "route-unresolvable"],
  ])("%s that cannot be resolved is the router's row 1", async (_name, _unused, key, value, reason) => {
    const { home, resolutionOwn } = activeFixture();
    const result = await performMigrationReportCommand({
      homeDir: home, generation: FIXTURE_GENERATION,
      _resolution: { _operationsForTesting: { ...resolutionOwn._operationsForTesting, readLink: () => ({ state: "unresolvable", reason: "multi-link", detail: "x" }) as never } },
      _operationsForTesting: present,
    });
    expect(result.reason).toBe(reason);
    expect(result.evidence).toMatchObject({ [key]: value, activationLinkReason: "multi-link" });
  });

  it.each([
    ["an activation report that cannot be read", { readActivationReport: () => ({ state: "unresolvable", reason: "malformed-record", detail: "x" }) as never }, { activationReport: "unresolvable", activationReportReason: "malformed-record" }],
    ["an activation report the manifest names but the store lacks", { readActivationReport: () => ({ state: "authoritatively-absent", detail: "x" }) as never }, { activationReport: "missing" }],
    ["an activation report reader that throws", { readActivationReport: () => { throw new TypeError("boom"); } }, { activationReport: "unresolvable", activationReportReason: "TypeError" }],
    ["unresolvable bindings", { resolveBindings: () => ({ state: "unresolvable", reason: "free text /secret" }) as never }, { generationBinding: "unresolvable" }],
    ["a bindings reader that throws", { resolveBindings: () => { throw new RangeError("boom"); } }, { generationBinding: "unresolvable", generationBindingReason: "RangeError" }],
    ["an unresolvable epoch store", { readActivationEvidence: () => ({ state: "unresolvable", reason: "free text" }) as never }, { rollbackEvidence: "unresolvable" }],
    ["an epoch store reader that throws", { readActivationEvidence: () => { throw new RangeError("boom"); } }, { rollbackEvidence: "unresolvable", rollbackEvidenceReason: "RangeError" }],
    ["a rollback authority artifact that cannot be read", { readRollbackAuthority: () => { throw new SyntaxError("boom"); } }, { rollbackAuthority: "unresolvable", rollbackAuthorityReason: "SyntaxError" }],
  ])("%s is exit 5 (report-evidence-unresolvable) and still prints every section", async (_name, override, expected) => {
    const { home, resolutionOwn } = activeFixture();
    const result = await performMigrationReportCommand({
      homeDir: home, generation: FIXTURE_GENERATION, _resolution: resolutionOwn, _operationsForTesting: { ...present, ...override },
    });
    expect(result.reason).toBe("report-evidence-unresolvable");
    expect(result.evidence).toMatchObject({ ...expected, cell: 10 });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("a rollback report the manifest names but the store lacks, or cannot read, is exit 5", async () => {
    const home = makeFixtureHome(roots);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "rolled-back");
    const missing = await performMigrationReportCommand({
      homeDir: home, generation: FIXTURE_GENERATION, _resolution: resolution, _operationsForTesting: { ...present, readRollbackReport: () => null },
    });
    expect(missing).toMatchObject({ reason: "report-evidence-unresolvable", evidence: { rollbackReport: "missing" } });
    const throwing = await performMigrationReportCommand({
      homeDir: home, generation: FIXTURE_GENERATION, _resolution: resolution, _operationsForTesting: { ...present, readRollbackReport: () => { throw new SyntaxError("boom"); } },
    });
    expect(throwing).toMatchObject({ reason: "report-evidence-unresolvable", evidence: { rollbackReport: "unresolvable", rollbackReportReason: "SyntaxError" } });
  });

  it("an unresolvable reader outranks a restart refusal, and a router refusal outranks both", async () => {
    const { home, resolutionOwn } = activeFixture();
    const restartRequired = restartOps(verdict("unsatisfied"), { status: "present", storageBackend: "sqlite", pid: 7, daemonInstanceId: "d" });
    const evidenceFirst = await performMigrationReportCommand({
      homeDir: home, generation: FIXTURE_GENERATION, _resolution: resolutionOwn,
      _operationsForTesting: { ...present, ...restartRequired, resolveBindings: () => ({ state: "unresolvable", reason: "x" }) as never },
    });
    expect(evidenceFirst.reason).toBe("report-evidence-unresolvable");
    const restartOnly = await performMigrationReportCommand({
      homeDir: home, generation: FIXTURE_GENERATION, _resolution: resolutionOwn, _operationsForTesting: { ...present, ...restartRequired },
    });
    expect(restartOnly.reason).toBe("report-restart-required");
  });

  it("uses the real readers when none are injected: an empty home has no activation or rollback evidence", async () => {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "planned");
    const result = await performMigrationReportCommand({ homeDir: home, _resolution: resolution });
    expect(result.evidence).toMatchObject({
      activationLink: "absent", activationReport: "none", generationBinding: "absent", rollbackEvidence: "absent", rollbackReport: "none", rollbackAuthority: "absent",
    });
  });
});

