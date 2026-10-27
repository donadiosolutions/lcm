import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { ActivationRestartCheckResult } from "../../src/migration/activation-restart-check.js";
import { performMigrationRollbackCommand, type MigrationRollbackCommandOperations } from "../../src/migration/cli-rollback.js";
import type { MigrationDaemonPresence } from "../../src/migration/daemon-presence.js";
import type { MigrationJournalObservation } from "../../src/migration/journal-observation.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { beginMigrationEffect, completeMigrationEffect, type MigrationManifest } from "../../src/migration/protocol.js";
import { MIGRATION_ROLLBACK_ERROR_REASONS, MigrationRollbackError } from "../../src/migration/rollback-inputs.js";
import {
  createFixtureManifest,
  FIXTURE_AT,
  FIXTURE_GENERATION,
  heldFixtureJournal,
  makeFixtureHome,
  removeFixtureHomes,
  snapshotHome,
} from "./existing-fixtures.js";

const roots: string[] = [];
afterEach(() => removeFixtureHomes(roots));

const H = (c: string): string => c.repeat(64);
const complete = async () => ({ state: "complete" as const, witness: {} as never });
const link = (publicationId: string) => ({
  state: "resolved" as const, path: "/ignored",
  link: { version: 1, generationId: FIXTURE_GENERATION, publicationId, identityDigest: H("d"), epochManifestRevision: 4, epochManifestChecksumSha256: H("e") },
}) as never;

function verdict(status: ActivationRestartCheckResult["status"]): ActivationRestartCheckResult {
  return {
    status, reason: status === "satisfied" ? "backend-matches" : status === "unsatisfied" ? "backend-stale" : "health-unreachable",
    detail: "x", pid: 7, observedBackend: null, selectedBackend: "sqlite",
  };
}
const present = (storageBackend: string): MigrationDaemonPresence => ({ status: "present", storageBackend, pid: 7, daemonInstanceId: "d" });
const ABSENT: MigrationDaemonPresence = { status: "authoritatively-absent" };

function restartOps(status: ActivationRestartCheckResult["status"] = "satisfied", presence: MigrationDaemonPresence = ABSENT) {
  return { checkRestart: async () => verdict(status), classifyPresence: async () => presence, readDaemonPort: () => 1234 };
}

/** Router row 10: this generation's own completed v2 publication and an active manifest. */
function activeState() {
  const home = makeFixtureHome(roots);
  createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "active");
  const observation: MigrationJournalObservation = { kind: "publication", publicationId: "pub-1", phase: "completed" };
  return { home, resolution: { _operationsForTesting: { observeJournal: () => observation, classifySnapshot: complete, readLink: () => link("pub-1") } } };
}

/** Router row 13: a settled rolled-back manifest and no journal. */
function rolledBackState() {
  const home = makeFixtureHome(roots);
  createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "rolled-back");
  return { home, resolution: { _operationsForTesting: { classifySnapshot: complete } } };
}

/** The real protocol steps of a rollback, applied to the active manifest in the home. */
function rollBack(home: string): MigrationManifest {
  const store = new MigrationManifestStore({ homeDir: home });
  const step = (update: (current: MigrationManifest) => MigrationManifest): MigrationManifest =>
    store.update(FIXTURE_GENERATION, store.read(FIXTURE_GENERATION).checksumSha256, update);
  step((current) => beginMigrationEffect(current, { kind: "prepare-rollback", effectId: "pr", inputSha256: H("a"), startedAt: FIXTURE_AT }));
  step((current) => completeMigrationEffect(current, { effectId: "pr", completedAt: FIXTURE_AT }));
  step((current) => beginMigrationEffect(current, { kind: "publish-rollback", effectId: "pu", inputSha256: H("a"), startedAt: FIXTURE_AT }));
  return step((current) => completeMigrationEffect(current, {
    effectId: "pu", completedAt: FIXTURE_AT, rollbackMode: "pre-write",
    report: { kind: "rollback", reportId: "rollback-report", reportSha256: H("c"), createdAt: FIXTURE_AT },
  }));
}

const ROLLBACK_REPORT = {
  version: 1, reportId: "rollback-report", generationId: FIXTURE_GENERATION, effectId: "pu", kind: "rollback",
  eligibility: "pre-write", mode: "pre-write", epochId: "e", attemptId: "a", sealedPublicationMaterialDigestSha256: H("9"),
  reason: null, selectionBindingManifestRevision: 7, checksumSha256: H("c"),
} as never;

type RunInput = Parameters<typeof performMigrationRollbackCommand>[0];
const run = (home: string, resolution: object, extra: Partial<RunInput> = {}) =>
  performMigrationRollbackCommand({
    homeDir: home, generation: FIXTURE_GENERATION, confirmGenerationId: FIXTURE_GENERATION, confirmBackend: "sqlite",
    _resolution: resolution as never, ...extra,
  });

describe("rollback: admission and the two fences", () => {
  it("names the owner of a cell it does not own (exit 2) and calls nothing", async () => {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "planned");
    const runRollback = vi.fn();
    const result = await run(home, { _operationsForTesting: { classifySnapshot: complete } }, { _operationsForTesting: { run: runRollback } });
    expect(result).toEqual({ status: "refuse", reason: "route-not-owner", generationId: FIXTURE_GENERATION, next: "resume" });
    expect(runRollback).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing generation token", { confirmGenerationId: undefined }, "existing-confirmation-missing"],
    ["a mismatched generation token", { confirmGenerationId: "generation-2" }, "existing-confirmation-moved"],
    ["a missing backend token", { confirmBackend: undefined }, "backend-confirmation-missing"],
    ["a mismatched backend token (postgresql)", { confirmBackend: "postgresql" }, "backend-confirmation-moved"],
  ])("%s refuses at the fence and leaves the home byte-identical", async (_name, extra, reason) => {
    const { home, resolution } = activeState();
    const before = snapshotHome(home);
    const runRollback = vi.fn();
    const result = await run(home, resolution, { ...extra, _operationsForTesting: { run: runRollback } });
    expect(result).toEqual({ status: "refuse", reason, generationId: FIXTURE_GENERATION });
    expect(runRollback).not.toHaveBeenCalled();
    expect(snapshotHome(home)).toEqual(before);
  });

  it("resolves the live hold when --generation is omitted (a verified generation is rolled back at row 24)", async () => {
    const home = makeFixtureHome(roots);
    await heldFixtureJournal(home);
    createFixtureManifest(new MigrationManifestStore({ homeDir: home }), "verified");
    const runRollback = vi.fn(async () => { throw new MigrationRollbackError("not-eligible", "x"); });
    const result = await run(home, { _operationsForTesting: { classifySnapshot: complete } }, { generation: undefined, _operationsForTesting: { run: runRollback } });
    expect(result).toMatchObject({ status: "refuse", reason: "rollback-refused-precondition", sections: { cell: 24 } });
  });
});

describe("rollback --dry-run: the route and the manifest only, never exit 0", () => {
  it("lists what it did not evaluate, calls neither the entry point nor the restart check, and writes nothing", async () => {
    const { home, resolution } = activeState();
    const before = snapshotHome(home);
    const runRollback = vi.fn();
    const checkRestart = vi.fn();
    const result = await run(home, resolution, { dryRun: true, _operationsForTesting: { run: runRollback, restart: { checkRestart } } });
    expect(result).toEqual({
      status: "refuse", reason: "rollback-dry-run-not-predictive", generationId: FIXTURE_GENERATION, next: "rollback (drop --dry-run to run it)",
      sections: {
        cell: 10, manifestPhase: "active", pendingEffect: null, predictive: false,
        notEvaluated: "eligibility,mode,quiescence,lease,drift,remote-binding,restart",
      },
    });
    expect(runRollback).not.toHaveBeenCalled();
    expect(checkRestart).not.toHaveBeenCalled();
    expect(snapshotHome(home)).toEqual(before);
  });
});

describe("rollback: success needs the manifest at rolled-back, read back, and the sqlite restart cell", () => {
  it("exits 0 for a rollback that moved the manifest: the call's own mode and report are rendered", async () => {
    const { home, resolution } = activeState();
    const controller = new AbortController();
    const runRollback = vi.fn(async () => ({ manifest: rollBack(home), report: ROLLBACK_REPORT }));
    const result = await run(home, resolution, { signal: controller.signal, _operationsForTesting: { run: runRollback, restart: restartOps() } });
    expect(runRollback).toHaveBeenCalledWith({ homeDir: home, generationId: FIXTURE_GENERATION, signal: controller.signal });
    expect(result).toMatchObject({
      status: "ok", generationId: FIXTURE_GENERATION, manifestPhase: "rolled-back", applied: true, next: "report",
      restart: { answer: "satisfied", presence: "absent" },
      evidence: {
        cell: 10, rollbackMode: "pre-write", rollbackEligibility: "pre-write", reportId: "rollback-report", reportSha256: H("c"),
        selectedBackend: "sqlite", restartCheckReason: "backend-matches",
      },
    });
  });

  it("a settled re-entry applied nothing, and without a report the mode comes from the lineage", async () => {
    const { home, resolution } = rolledBackState();
    const manifest = new MigrationManifestStore({ homeDir: home }).read(FIXTURE_GENERATION);
    const runRollback = vi.fn(async () => ({ manifest, report: null }));
    const result = await run(home, resolution, { _operationsForTesting: { run: runRollback, restart: restartOps() } });
    expect(result).toMatchObject({
      status: "ok", applied: false, manifestPhase: "rolled-back",
      evidence: { cell: 13, rollbackMode: "pre-write", rollbackEligibility: null },
    });
    expect((result as { evidence: Record<string, unknown> }).evidence).not.toHaveProperty("reportId");
  });

  it("a live daemon already on sqlite is satisfied", async () => {
    const { home, resolution } = rolledBackState();
    const manifest = new MigrationManifestStore({ homeDir: home }).read(FIXTURE_GENERATION);
    const result = await run(home, resolution, {
      _operationsForTesting: { run: async () => ({ manifest, report: null }), restart: restartOps("satisfied", present("sqlite")) },
    });
    expect(result).toMatchObject({ status: "ok", restart: { answer: "satisfied", presence: "running" } });
  });

  it.each([
    ["an unsatisfied verdict with a stale live daemon is exit 8", "unsatisfied", present("postgresql"), "cutover-restart-required"],
    ["a satisfied verdict with a stale live daemon contradicts", "satisfied", present("postgresql"), "cutover-restart-contradiction"],
    ["an unsatisfied verdict with no daemon contradicts", "unsatisfied", ABSENT, "cutover-restart-contradiction"],
    ["an unresolvable verdict is unresolvable", "unresolvable", ABSENT, "cutover-restart-unresolvable"],
  ] as const)("%s", async (_name, status, presence, reason) => {
    const { home, resolution } = activeState();
    const result = await run(home, resolution, {
      _operationsForTesting: { run: async () => ({ manifest: rollBack(home), report: ROLLBACK_REPORT }), restart: restartOps(status, presence) },
    });
    expect(result).toMatchObject({ status: "refuse", reason, generationId: FIXTURE_GENERATION, applied: true });
    expect((result as { restart: unknown }).restart).not.toBeNull();
  });

  it("a restart check that cannot be made fails closed", async () => {
    const { home, resolution } = rolledBackState();
    const manifest = new MigrationManifestStore({ homeDir: home }).read(FIXTURE_GENERATION);
    const result = await run(home, resolution, {
      _operationsForTesting: {
        run: async () => ({ manifest, report: null }),
        restart: { checkRestart: async () => { throw new TypeError("boom"); }, classifyPresence: async () => ABSENT, readDaemonPort: () => 1 },
      },
    });
    expect(result).toMatchObject({ status: "refuse", reason: "cutover-restart-unresolvable", restart: null, sections: { restartObservation: "TypeError" } });
    expect(result).not.toHaveProperty("applied");
  });

  it("uses the real restart checker and presence classifier when none are injected: a home with no daemon is satisfied", async () => {
    const { home, resolution } = rolledBackState();
    const manifest = new MigrationManifestStore({ homeDir: home }).read(FIXTURE_GENERATION);
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a TCP listener");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    writeFileSync(join(home, ".lcm", "config.json"), JSON.stringify({ daemon: { port: address.port } }), { mode: 0o600 });
    const result = await run(home, resolution, { _operationsForTesting: { run: async () => ({ manifest, report: null }) } });
    expect(result).toMatchObject({ status: "ok", restart: { answer: "satisfied", presence: "absent" } });
  });
});

describe("rollback: a normal return that is not a rollback is never exit 0 and never runs the restart check (plan-v6.1 A-P0-2)", () => {
  it("the abandoned publish-rollback (manifest back at active, abandonment report) is exit 2: run rollback again", async () => {
    const { home, resolution } = activeState();
    const manifest = new MigrationManifestStore({ homeDir: home }).read(FIXTURE_GENERATION);
    const checkRestart = vi.fn();
    const result = await run(home, resolution, {
      _operationsForTesting: {
        run: async () => ({ manifest, report: { ...(ROLLBACK_REPORT as object), kind: "abandonment", reportId: "abandon-1", checksumSha256: H("7"), reason: "free text /secret" } as never }),
        restart: { checkRestart },
      },
    });
    expect(result).toEqual({
      status: "refuse", reason: "rollback-abandoned", generationId: FIXTURE_GENERATION, applied: true, next: "rollback",
      sections: { cell: 10, manifestPhase: "active", abandonmentReportId: "abandon-1", abandonmentReportSha256: H("7") },
    });
    expect(checkRestart).not.toHaveBeenCalled();
  });

  it("a rolled-back manifest that still has an effect pending is not a rollback either", async () => {
    const { home, resolution } = rolledBackState();
    const manifest = new MigrationManifestStore({ homeDir: home }).read(FIXTURE_GENERATION);
    const pending = { ...manifest, pendingEffect: { effectId: "e" } } as never;
    const result = await run(home, resolution, { _operationsForTesting: { run: async () => ({ manifest: pending, report: null }) } });
    expect(result).toEqual({ status: "refuse", reason: "rollback-readback-mismatch", evidence: "manifest-rolled-back", generationId: FIXTURE_GENERATION, applied: true });
  });

  it("another phase with no abandonment report is a read-back mismatch", async () => {
    const { home, resolution } = activeState();
    const manifest = new MigrationManifestStore({ homeDir: home }).read(FIXTURE_GENERATION);
    const result = await run(home, resolution, { _operationsForTesting: { run: async () => ({ manifest, report: ROLLBACK_REPORT }) } });
    expect(result).toEqual({ status: "refuse", reason: "rollback-readback-mismatch", evidence: "manifest-active", generationId: FIXTURE_GENERATION, applied: true });
    const noReport = await run(home, resolution, { _operationsForTesting: { run: async () => ({ manifest, report: null }) } });
    expect(noReport).toMatchObject({ reason: "rollback-readback-mismatch" });
  });

  it("a result for another generation is not accepted", async () => {
    const { home, resolution } = rolledBackState();
    const manifest = new MigrationManifestStore({ homeDir: home }).read(FIXTURE_GENERATION);
    const result = await run(home, resolution, { _operationsForTesting: { run: async () => ({ manifest: { ...manifest, generationId: "generation-2" }, report: null }) } });
    expect(result).toEqual({ status: "refuse", reason: "rollback-readback-mismatch", evidence: "generation-mismatch", generationId: FIXTURE_GENERATION, applied: true });
  });

  it("a returned rolled-back manifest that does not read back from disk is a mismatch", async () => {
    const { home, resolution } = activeState();
    const rolled = { ...new MigrationManifestStore({ homeDir: home }).read(FIXTURE_GENERATION), phase: "rolled-back" } as MigrationManifest;
    const result = await run(home, resolution, { _operationsForTesting: { run: async () => ({ manifest: rolled, report: null }) } });
    expect(result).toEqual({ status: "refuse", reason: "rollback-readback-mismatch", evidence: "manifest-active", generationId: FIXTURE_GENERATION, applied: true });
  });

  it("a returned manifest that cannot be read back is a mismatch", async () => {
    const { home, resolution } = rolledBackState();
    const store = new MigrationManifestStore({ homeDir: home });
    const manifest = store.read(FIXTURE_GENERATION);
    let reads = 0;
    const flaky = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "read") return (id: string) => { reads += 1; if (reads > 1) throw new Error("gone"); return target.read(id); };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const result = await run(home, resolution, { manifestStore: flaky, _operationsForTesting: { run: async () => ({ manifest, report: null }) } });
    expect(result).toEqual({ status: "refuse", reason: "rollback-readback-mismatch", evidence: "manifest-unreadable", generationId: FIXTURE_GENERATION, applied: true });
  });
});

describe("rollback: thrown errors (the seven closed reasons)", () => {
  const EXPECTED: Readonly<Record<(typeof MIGRATION_ROLLBACK_ERROR_REASONS)[number], string>> = {
    "not-eligible": "rollback-refused-precondition",
    "quiescence-unsatisfied": "rollback-refused-precondition",
    "lease-lost": "rollback-contention",
    unresolvable: "rollback-refused-evidence",
    "input-unresolvable": "rollback-refused-evidence",
    drift: "rollback-refused-evidence",
    "unexpected-state": "rollback-refused-evidence",
  };

  it.each(MIGRATION_ROLLBACK_ERROR_REASONS.map((reason) => [reason, EXPECTED[reason]] as const))(
    "%s maps to %s, renders the upstream reason, and claims no write when the manifest did not move", async (reason, cliReason) => {
      const { home, resolution } = activeState();
      const result = await run(home, resolution, { _operationsForTesting: { run: async () => { throw new MigrationRollbackError(reason, "boom at /secret/path"); } } });
      expect(result).toEqual({ status: "refuse", reason: cliReason, generationId: FIXTURE_GENERATION, sections: { cell: 10, rollbackReason: reason } });
    },
  );

  it("claims a write when the manifest moved during the failed attempt", async () => {
    const { home, resolution } = activeState();
    const result = await run(home, resolution, {
      _operationsForTesting: {
        run: async () => {
          const store = new MigrationManifestStore({ homeDir: home });
          store.update(FIXTURE_GENERATION, store.read(FIXTURE_GENERATION).checksumSha256, (current) =>
            beginMigrationEffect(current, { kind: "prepare-rollback", effectId: "pr", inputSha256: H("a"), startedAt: FIXTURE_AT }));
          throw new MigrationRollbackError("lease-lost", "x");
        },
      },
    });
    expect(result).toMatchObject({ reason: "rollback-contention", applied: true });
  });

  it("claims a write when the manifest cannot be read back after the failed attempt", async () => {
    const { home, resolution } = activeState();
    const store = new MigrationManifestStore({ homeDir: home });
    let reads = 0;
    const flaky = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "read") return (id: string) => { reads += 1; if (reads > 1) throw new Error("gone"); return target.read(id); };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const result = await run(home, resolution, {
      manifestStore: flaky, _operationsForTesting: { run: async () => { throw new MigrationRollbackError("unresolvable", "x"); } },
    });
    expect(result).toMatchObject({ reason: "rollback-refused-evidence", applied: true });
  });

  it("a reason this build does not know reaches the boundary instead of a guessed class", async () => {
    const { home, resolution } = activeState();
    const forged = new MigrationRollbackError("brand-new" as never, "x");
    const result = await run(home, resolution, { _operationsForTesting: { run: async () => { throw forged; } } });
    expect(result).toEqual({ status: "refuse", reason: "unexpected-failure", evidence: "MigrationRollbackError", applied: true });
  });

  it("any other error is the boundary's unexpected-failure (exit 5)", async () => {
    const { home, resolution } = activeState();
    const result = await run(home, resolution, { _operationsForTesting: { run: async () => { throw new RangeError("boom"); } } });
    expect(result).toEqual({ status: "refuse", reason: "unexpected-failure", evidence: "RangeError", applied: true });
  });

  it("uses the real entry point when none is injected (a home with no capture cannot resolve its inputs)", async () => {
    const { home, resolution } = activeState();
    const result = await run(home, resolution);
    expect(result).toMatchObject({ status: "refuse", reason: "rollback-refused-evidence", sections: { rollbackReason: expect.stringMatching(/^(input-unresolvable|unexpected-state)$/) } });
  });
});
