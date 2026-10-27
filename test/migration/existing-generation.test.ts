import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { refuseUnlessRouted, resolveExistingMigrationGeneration } from "../../src/migration/existing-generation.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { beginMigrationEffect, createMigrationManifest, type MigrationManifest } from "../../src/migration/protocol.js";
import { routeMigrationGeneration, type MigrationRouteInput } from "../../src/migration/routing.js";
import type { MigrationJournalObservation } from "../../src/migration/journal-observation.js";
import type { BackendMaintenanceJournal, BackendMaintenancePhase } from "../../src/storage/backend-publication.js";

import { migrationExitClassForName } from "../../src/migration/exit-classes.js";
import { MIGRATION_REFUSAL_REASONS } from "../../src/migration/refusal-mapping.js";

function exitCodeOfReason(reason: string): number {
  const entry = MIGRATION_REFUSAL_REASONS.find((candidate) => candidate.reason === reason);
  if (entry === undefined) throw new Error(`reason missing from the closed table: ${reason}`);
  return migrationExitClassForName(entry.exitClass).code;
}

const roots: string[] = [];
const AT = "2026-08-12T12:00:00.000Z";
const GEN = "generation-1";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-existing-generation-"));
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  roots.push(value);
  return value;
}

function witness(sha: string, backend: "sqlite" | "postgresql") {
  return { version: 1 as const, backend, identitySha256: sha, schemaSha256: sha, contentSha256: sha, capturedAt: AT };
}

function planned(generationId = GEN): MigrationManifest {
  return createMigrationManifest({
    generationId, source: witness("1".repeat(64), "sqlite"), destination: witness("2".repeat(64), "postgresql"),
    parentGenerationId: null, preservedSourceGenerationId: generationId, createdAt: AT,
  });
}

function hold(phase: BackendMaintenancePhase, generationId = GEN): MigrationJournalObservation {
  return { kind: "hold", journal: { phase, generationId } as BackendMaintenanceJournal };
}

const complete = async () => ({ state: "complete" as const, witness: {} as never });
const absentSnapshot = async () => ({ state: "absent" as const });

describe("resolveExistingMigrationGeneration", () => {
  it("resolves an omitted --generation to the live non-terminal hold and routes the observed cell", async () => {
    const homeDir = home();
    const result = await resolveExistingMigrationGeneration({
      homeDir, _operationsForTesting: { observeJournal: () => hold("maintenance-held"), classifySnapshot: absentSnapshot },
    });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("unreachable");
    expect(result.context.generationId).toBe(GEN);
    expect(result.context.manifest).toBeNull();
    expect(result.context.route.row).toBe(15);
  });

  it.each([
    ["an absent journal", { kind: "absent" } as MigrationJournalObservation],
    ["a terminal hold", hold("maintenance-aborted")],
    ["a v2 publication", { kind: "publication", publicationId: "p", phase: "preparing" } as MigrationJournalObservation],
  ])("requires --generation when it is omitted and the journal is %s", async (_name, observation) => {
    const result = await resolveExistingMigrationGeneration({ homeDir: home(), _operationsForTesting: { observeJournal: () => observation } });
    expect(result).toEqual({ status: "refuse", reason: "generation-required" });
  });

  it("surfaces an unresolvable journal as evidence when --generation is omitted, never as an absent one", async () => {
    const result = await resolveExistingMigrationGeneration({
      homeDir: home(), _operationsForTesting: { observeJournal: () => ({ kind: "unresolvable", evidence: "journal-checksum-mismatch" }) },
    });
    expect(result).toEqual({ status: "refuse", reason: "journal-unresolvable", evidence: "journal-checksum-mismatch" });
  });

  it("refuses a malformed explicit id as a usage error", async () => {
    const result = await resolveExistingMigrationGeneration({
      homeDir: home(), generation: "../escape", _operationsForTesting: { observeJournal: () => hold("maintenance-held") },
    });
    expect(result).toEqual({ status: "refuse", reason: "generation-invalid" });
  });

  it("refuses an explicit id with no manifest and no journal as unknown", async () => {
    const result = await resolveExistingMigrationGeneration({
      homeDir: home(), generation: GEN, _operationsForTesting: { observeJournal: () => ({ kind: "absent" }) },
    });
    expect(result).toEqual({ status: "refuse", reason: "generation-unknown" });
  });

  it.each([
    ["a live hold", hold("maintenance-held", "generation-other")],
    ["an entering hold", hold("maintenance-entering", "generation-other")],
    ["a terminal hold", hold("maintenance-aborted", "generation-other")],
    ["a v2 publication", { kind: "publication", publicationId: "generation-other", phase: "completed" } as MigrationJournalObservation],
  ])("refuses an explicit id with no manifest as unknown when the only journal is %s for another generation (Codex PR #1653: a typo must not route against a stranger's hold)", async (_name, observation) => {
    const result = await resolveExistingMigrationGeneration({
      homeDir: home(), generation: GEN, _operationsForTesting: { observeJournal: () => observation, classifySnapshot: absentSnapshot },
    });
    expect(result).toEqual({ status: "refuse", reason: "generation-unknown" });
  });

  it("a hold naming the explicit id is evidence it exists even before its manifest (captured, genesis not yet run)", async () => {
    const result = await resolveExistingMigrationGeneration({
      homeDir: home(), generation: GEN, _operationsForTesting: { observeJournal: () => hold("maintenance-held"), classifySnapshot: complete },
    });
    expect(result).toMatchObject({ status: "resolved", context: { generationId: GEN, manifest: null } });
  });

  it("an explicit id with a manifest still routes to row 4 while another generation's hold is live (plan-v5 §3)", async () => {
    const homeDir = home();
    new MigrationManifestStore({ homeDir }).create(planned());
    const result = await resolveExistingMigrationGeneration({
      homeDir, generation: GEN, _operationsForTesting: { observeJournal: () => hold("maintenance-held", "generation-other"), classifySnapshot: complete },
    });
    expect(result).toMatchObject({ status: "resolved", context: { route: { row: 4, primary: "abort" } } });
  });

  it("reads a present manifest once and routes its phase and pending effect (row 19: held, complete snapshot, planned)", async () => {
    const homeDir = home();
    new MigrationManifestStore({ homeDir }).create(planned());
    const result = await resolveExistingMigrationGeneration({
      homeDir, generation: GEN, _operationsForTesting: { observeJournal: () => hold("maintenance-held"), classifySnapshot: complete },
    });
    if (result.status !== "resolved") throw new Error("unreachable");
    expect(result.context.manifest?.phase).toBe("planned");
    expect(result.context.snapshot).toBe("complete");
    expect(result.context.route.row).toBe(19);
  });

  it("routes a pending effect (row 20: pending verify-dry-run)", async () => {
    const homeDir = home();
    const store = new MigrationManifestStore({ homeDir });
    const created = store.create(planned());
    store.update(GEN, created.checksumSha256, (m) => beginMigrationEffect(m, { kind: "verify-dry-run", effectId: "e", inputSha256: "c".repeat(64), startedAt: AT }));
    const result = await resolveExistingMigrationGeneration({
      homeDir, generation: GEN, _operationsForTesting: { observeJournal: () => hold("maintenance-held"), classifySnapshot: complete },
    });
    if (result.status !== "resolved") throw new Error("unreachable");
    expect(result.context.route.row).toBe(20);
  });

  it("treats an unreadable manifest tree as unresolvable evidence (row 1), never as absence", async () => {
    const homeDir = home();
    const migrations = join(homeDir, ".lcm", "migrations");
    mkdirSync(migrations, { mode: 0o700 });
    chmodSync(migrations, 0o755);
    let result;
    try {
      result = await resolveExistingMigrationGeneration({
        homeDir, generation: GEN, _operationsForTesting: { observeJournal: () => hold("maintenance-held"), classifySnapshot: absentSnapshot },
      });
    } finally {
      chmodSync(migrations, 0o700);
    }
    if (result.status !== "resolved") throw new Error("unreachable");
    expect(result.context.route.row).toBe(1);
  });

  it("treats a manifest read that throws something unrecognised as unresolvable (row 1)", async () => {
    const throwingStore = {
      probeManifestPresence: () => ({ status: "present" as const }),
      read: () => { throw new Error("boom"); },
    } as unknown as MigrationManifestStore;
    const result = await resolveExistingMigrationGeneration({
      homeDir: home(), generation: GEN, manifestStore: throwingStore,
      _operationsForTesting: { observeJournal: () => hold("maintenance-held"), classifySnapshot: absentSnapshot },
    });
    if (result.status !== "resolved") throw new Error("unreachable");
    expect(result.context.route.row).toBe(1);
  });

  it("treats a snapshot classification that throws as unresolvable (row 1)", async () => {
    const result = await resolveExistingMigrationGeneration({
      homeDir: home(), generation: GEN,
      _operationsForTesting: {
        observeJournal: () => hold("maintenance-held"),
        classifySnapshot: async () => { throw new Error("boom"); },
      },
    });
    if (result.status !== "resolved") throw new Error("unreachable");
    expect(result.context.route.row).toBe(1);
  });

  it("does not treat a stranger's v2 publication as exit 4 when the explicit id is known: the router decides (row 3 for a completed one)", async () => {
    const homeDir = home();
    new MigrationManifestStore({ homeDir }).create(planned());
    const result = await resolveExistingMigrationGeneration({
      homeDir, generation: GEN,
      _operationsForTesting: {
        observeJournal: () => ({ kind: "publication", publicationId: "p", phase: "completed" }),
        classifySnapshot: absentSnapshot,
      },
    });
    if (result.status !== "resolved") throw new Error("unreachable");
    expect(result.context.route.row).toBe(3);
  });

  it("reads a real journal from disk when none is injected", async () => {
    const result = await resolveExistingMigrationGeneration({ homeDir: home(), generation: GEN });
    expect(result).toEqual({ status: "refuse", reason: "generation-unknown" });
  });

  describe("the activation link feeds the router (plan-v5 Part B (1))", () => {
    const ownPublication = (phase: "releasing" | "completed"): MigrationJournalObservation =>
      ({ kind: "publication", publicationId: "pub-1", phase });
    const linkResult = (publicationId: string) => ({
      state: "resolved" as const, path: "/ignored",
      link: { version: 1, generationId: GEN, publicationId, identityDigest: "d".repeat(64), epochManifestRevision: 4, epochManifestChecksumSha256: "e".repeat(64) },
    }) as never;

    async function resolveWith(readLink: () => never, observation: MigrationJournalObservation) {
      const homeDir = home();
      const store = new MigrationManifestStore({ homeDir });
      store.create(planned());
      const result = await resolveExistingMigrationGeneration({
        homeDir, generation: GEN, manifestStore: store,
        _operationsForTesting: { observeJournal: () => observation, classifySnapshot: absentSnapshot, readLink },
      });
      if (result.status !== "resolved") throw new Error("unreachable");
      return result.context;
    }

    it("a resolved link naming the journal's publication makes it the generation's own (a foreign one is row 2)", async () => {
      const own = await resolveWith(() => linkResult("pub-1"), ownPublication("releasing"));
      expect(own.activationLink.state).toBe("resolved");
      expect(own.route.row).not.toBe(2);
      const foreign = await resolveWith(() => linkResult("other"), ownPublication("releasing"));
      expect(foreign.route.row).toBe(2);
    });

    it("an authoritatively absent link routes as absent", async () => {
      const context = await resolveWith(() => ({ state: "authoritatively-absent", detail: "none" }) as never, ownPublication("releasing"));
      expect(context.activationLink.state).toBe("authoritatively-absent");
      expect(context.route.row).toBe(2);
    });

    it("an unresolvable link is row 1 (exit 5), never absence", async () => {
      const context = await resolveWith(
        () => ({ state: "unresolvable", reason: "multi-link", detail: "x" }) as never, ownPublication("releasing"),
      );
      expect(context.route.row).toBe(1);
    });

    it("a reader that throws is unresolvable evidence carrying only the error name", async () => {
      const context = await resolveWith(() => { throw new TypeError("boom with /secret/path"); }, ownPublication("releasing"));
      expect(context.activationLink).toEqual({ state: "unresolvable", reason: "read-unresolvable", detail: "TypeError" });
      expect(context.route.row).toBe(1);
      const unnamed = await resolveWith(() => { throw "not an error"; }, ownPublication("releasing"));
      expect(unnamed.activationLink).toMatchObject({ detail: "unknown-link-read-failure" });
    });

    it("reads the real link store when none is injected: an empty home has none", async () => {
      const homeDir = home();
      const store = new MigrationManifestStore({ homeDir });
      store.create(planned());
      const result = await resolveExistingMigrationGeneration({
        homeDir, generation: GEN, manifestStore: store,
        _operationsForTesting: { observeJournal: () => hold("maintenance-held"), classifySnapshot: complete },
      });
      if (result.status !== "resolved") throw new Error("unreachable");
      expect(result.context.activationLink.state).toBe("authoritatively-absent");
    });
  });
});

describe("refuseUnlessRouted", () => {
  const base: MigrationRouteInput = {
    journal: { kind: "hold", phase: "maintenance-held", generationId: GEN }, resolvedGenerationId: GEN,
    manifest: { kind: "absent" }, snapshot: "absent", link: { kind: "absent" },
  };
  const route = (overrides: Partial<MigrationRouteInput>) => routeMigrationGeneration({ ...base, ...overrides });

  it("lets the primary and an allowed command proceed, and report always", () => {
    const row15 = route({});
    expect(refuseUnlessRouted("apply", row15)).toBeNull();
    expect(refuseUnlessRouted("abort", row15)).toBeNull();
    expect(refuseUnlessRouted("report", row15)).toBeNull();
  });

  it.each([
    ["exit 2 names the owner", route({}), "verify", "route-not-owner", "apply"],
    ["exit 2 for a mismatched hold names abort", route({ manifest: { kind: "present", phase: "copied", pending: null }, snapshot: "complete", journal: { kind: "hold", phase: "maintenance-held", generationId: "other" } }), "verify", "route-not-owner", "abort"],
    ["exit 4 for a foreign in-flight publication", route({ journal: { kind: "publication", publicationId: "p", phase: "prepared" } }), "verify", "route-publication-in-flight", null],
    ["exit 6 for a pending effect", route({ snapshot: "complete", manifest: { kind: "present", phase: "planned", pending: "verify-dry-run" } }), "abort", "route-resume-required", "resume"],
    ["exit 6 for the rollback re-entry row", route({ manifest: { kind: "present", phase: "rolling-back", pending: null } }), "verify", "route-resume-required", "rollback"],
    ["exit 2 for activation row 24", route({ snapshot: "complete", manifest: { kind: "present", phase: "verified", pending: null } }), "resume", "route-not-owner", "activate"],
    ["exit 2 for activation row 11 with nothing pending", route({ journal: { kind: "hold", phase: "selection-prepared", generationId: GEN }, manifest: { kind: "present", phase: "verified", pending: null } }), "verify", "route-not-owner", "activate"],
    ["exit 6 for activation row 11 with a pending effect", route({ journal: { kind: "hold", phase: "selection-prepared", generationId: GEN }, manifest: { kind: "present", phase: "verified", pending: "prepare-activation" } }), "verify", "route-resume-required", "activate"],
    ["exit 7 for an operator-required cell", route({ journal: { kind: "hold", phase: "maintenance-aborted", generationId: GEN }, manifest: { kind: "present", phase: "copying", pending: "copy-batch" } }), "abort", "route-operator-required", null],
    ["exit 5 for an unresolvable observation", route({ snapshot: "unresolvable" }), "verify", "route-unresolvable", null],
    ["exit 5 for a stranger's completed publication", route({ journal: { kind: "publication", publicationId: "p", phase: "completed" } }), "verify", "route-foreign-publication", null],
    ["exit 5 for a contradiction", route({ manifest: { kind: "present", phase: "copied", pending: null } }), "verify", "route-contradiction", null],
  ])("%s", (_name, routed, command, reason, next) => {
    expect(refuseUnlessRouted(command as never, routed)).toEqual({ status: "refuse", reason, next });
    // The refusal's closed reason maps to exactly the exit the router reported.
    expect(exitCodeOfReason(reason as string)).toBe(routed.exitIfRefused);
  });

  it("maps the resolver's own refusals into the closed table: absent and unknown are exit 2, malformed is usage (1)", () => {
    expect(exitCodeOfReason("generation-required")).toBe(2);
    expect(exitCodeOfReason("generation-unknown")).toBe(2);
    expect(exitCodeOfReason("generation-invalid")).toBe(1);
  });
});
