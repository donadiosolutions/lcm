import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { MachineIdentityFileError } from "../../src/machine-identity.js";
import { lcmHomeDir } from "../../src/runtime-paths.js";
import { backendPublicationCanonicalSha256, backendPublicationJournalPath } from "../../src/storage/backend-publication.js";
import { PortableStreamError } from "../../src/storage/portable-record.js";
import { PostgreSqlStorageOperationError } from "../../src/storage/postgresql/errors.js";
import { activateCutoverSet, createCutoverSetActivateDependencies } from "../../src/migration/cutover-set-activate.js";
import { MigrationBindingUnresolvableError } from "../../src/migration/generation-binding-store.js";
import { MigrationProjectMapWitnessError } from "../../src/migration/project-map-witness.js";
import { cleanupRoots, expectNoEffects, fixture, HASH_A, roots, TARGET_CONFIG, type Fixture } from "./cutover-set-activate-fixture.js";
import { readCutoverSetActivationRecords } from "../../src/migration/cutover-set-activation-store.js";

afterEach(cleanupRoots);

/** Cutover-set activation classification (#1673): lazy scratch (#1618), storage-error classification (#1648), evidence-derived applied (#1617). */

function storageError(sqlState: string, retryable: boolean): PostgreSqlStorageOperationError {
  return new PostgreSqlStorageOperationError("STORAGE_OPERATION_FAILED", { domain: "factory", operation: "injected" }, sqlState, retryable);
}

const UNHEALTHY = () => storageError("28000", false);
const UNRESOLVABLE = () => storageError("08006", true);

function scratchDirs(homeDir: string): string[] {
  return existsSync(lcmHomeDir(homeDir)) ? readdirSync(lcmHomeDir(homeDir)).filter((name) => /scratch/u.test(name)) : [];
}

async function crashAt(f: Fixture, point: string): Promise<void> {
  await expect(f.run({ crashPoint: (p) => { if (p === point) throw new Error("crash at " + point); } })).rejects.toThrow("crash at " + point);
}

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

describe("activateCutoverSet: scratch is allocated only for a member census (#1673, #1618)", () => {
  it("an early refusal creates no scratch directory and never calls the allocator", async () => {
    const allocateScratch = vi.fn(() => { throw new Error("unexpected scratch allocation"); });
    const unheld = await fixture({ held: false });
    const seenUnheld: string[] = [];
    const journal = unheld.deps.readMaintenanceJournal;
    expect(await unheld.run({ allocateScratch, readMaintenanceJournal: (h) => { seenUnheld.push(...scratchDirs(h)); return journal(h); } }))
      .toMatchObject({ status: "refused", step: "S3", reason: "maintenance-not-held" });
    expect(seenUnheld).toEqual([]);
    const unregistered = await fixture();
    const seen: string[] = [];
    const read = unregistered.deps.readMaintenanceJournal;
    expect(await unregistered.run({
      allocateScratch,
      readMaintenanceJournal: (h) => { seen.push(...scratchDirs(h)); return read(h); },
      machineId: () => { seen.push(...scratchDirs(unregistered.homeDir)); throw new MachineIdentityFileError("missing", "injected"); },
    })).toMatchObject({ status: "refused", step: "S0", reason: "machine-identity-unregistered" });
    expect(seen).toEqual([]);
    expect(allocateScratch).not.toHaveBeenCalled();
  });

  it("an uninitialized home is classified as a refusal instead of throwing from the scratch allocation", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "lcm-cutover-set-empty-"));
    roots.push(homeDir);
    const outcome = await activateCutoverSet({ homeDir, confirmSetId: "cutover-set-1", targetConfig: TARGET_CONFIG });
    expect(outcome).toMatchObject({ status: "refused", effectBegun: false });
    expect(scratchDirs(homeDir)).toEqual([]);
  });

  it("a census scratch allocation failure makes the member unverifiable and refuses the set at S8 naming each member", async () => {
    const f = await fixture();
    const outcome = await f.run({ allocateScratch: () => { throw new Error("disk full"); } });
    expect(outcome).toMatchObject({
      status: "refused", step: "S8", effectBegun: false,
      members: [
        expect.objectContaining({ evidence: "unverifiable", reason: "state-unresolvable", detail: expect.stringContaining("census scratch directory could not be allocated: disk full") }),
        expect.objectContaining({ evidence: "unverifiable", reason: "state-unresolvable" }),
      ],
    });
    expectNoEffects(f);
  });

  it("each member census gets its own scratch directory, which is removed after a census read that throws", async () => {
    const f = await fixture();
    const allocated: string[] = [];
    const passed: string[] = [];
    const existedDuringRead: boolean[] = [];
    const real = f.deps.allocateScratch;
    const outcome = await f.run({
      allocateScratch: (home) => { const dir = real(home); allocated.push(dir); return dir; },
      readDestinationCensus: async (_session, census) => {
        passed.push(census.scratchParent);
        existedDuringRead.push(existsSync(census.scratchParent));
        throw UNHEALTHY();
      },
    });
    expect(outcome).toMatchObject({ status: "refused", step: "S8" });
    expect(allocated).toHaveLength(2);
    expect(new Set(allocated).size).toBe(2);
    expect(passed).toEqual(allocated);
    expect(existedDuringRead).toEqual([true, true]);
    for (const dir of allocated) expect(existsSync(dir)).toBe(false);
    expect(scratchDirs(f.homeDir)).toEqual([]);
  });
});

describe("activateCutoverSet: identity and census storage failures are classified per member (#1673, #1648)", () => {
  it.each([
    ["S0", 1, "S0"],
    ["S5", 3, "S5"],
    ["S7", 5, "S8"],
  ] as const)("a StorageOperationError from the %s destination identity query refuses with the target vocabulary", async (stage, call, step) => {
    for (const [make, reason] of [[UNHEALTHY, "target-unhealthy"], [UNRESOLVABLE, "target-unresolvable"]] as const) {
      const f = await fixture();
      let captures = 0;
      const outcome = await f.run({ captureDestinationIdentity: async () => { captures += 1; if (captures === call) throw make(); return { version: 1, ...f.deps.identity }; } });
      expect(outcome).toMatchObject({
        status: "refused", step, reason: "cutover-set-member-evidence-unverifiable", effectBegun: false,
        detail: expect.stringContaining(f.members[0]!.generationId),
        members: [expect.objectContaining({ evidence: "unverifiable", reason, detail: expect.stringContaining(stage + " destination identity query") }), expect.objectContaining({ evidence: null })],
      });
      expectNoEffects(f);
    }
  });

  it("after a checkpoint the same identity failure is a roll-forward interruption", async () => {
    const f = await fixture();
    await crashAt(f, "after-checkpoint");
    let captures = 0;
    expect(await f.run({ captureDestinationIdentity: async () => { captures += 1; if (captures === 1) throw UNHEALTHY(); return { version: 1, ...f.deps.identity }; } }))
      .toMatchObject({ status: "interrupted", step: "S9", cause: "state-unresolvable", effectBegun: true, detail: expect.stringContaining("target-unhealthy") });
  });

  it("a PortableStreamError(source-unavailable) wrapping a storage error from the census read refuses, per member", async () => {
    for (const [make, reason] of [[UNHEALTHY, "target-unhealthy"], [UNRESOLVABLE, "target-unresolvable"]] as const) {
      const f = await fixture();
      const outcome = await f.run({ readDestinationCensus: async () => { throw new PortableStreamError("source-unavailable", { cause: make() }); } });
      expect(outcome).toMatchObject({
        status: "refused", step: "S8", reason: "cutover-set-member-evidence-unverifiable", effectBegun: false,
        members: [expect.objectContaining({ evidence: "unverifiable", reason, detail: expect.stringContaining("S7 census read") }), expect.objectContaining({ evidence: "unverifiable", reason })],
      });
      expectNoEffects(f);
    }
  });

  it("cancellation, an unwrapped source failure and a plain error still reject", async () => {
    const f = await fixture();
    await expect(f.run({ readDestinationCensus: async () => { throw new PortableStreamError("aborted", { cause: UNHEALTHY() }); } })).rejects.toMatchObject({ code: "aborted" });
    await expect(f.run({ readDestinationCensus: async () => { throw new PortableStreamError("source-unavailable"); } })).rejects.toMatchObject({ code: "source-unavailable" });
    await expect(f.run({ readDestinationCensus: async () => { throw new Error("census exploded"); } })).rejects.toThrow("census exploded");
    await expect(f.run({ captureDestinationIdentity: async () => { throw new Error("capture exploded"); } })).rejects.toThrow("capture exploded");
  });
});

describe("activateCutoverSet: remaining classification seams (#1673)", () => {
  it("the real default allocator keeps the set scratch prefix under the LCM home", async () => {
    const f = await fixture();
    const dir = createCutoverSetActivateDependencies({ homeDir: f.homeDir }).allocateScratch(f.homeDir);
    try {
      expect(dirname(dir)).toBe(lcmHomeDir(f.homeDir));
      expect(basename(dir)).toMatch(/^cutover-set-activation-scratch-/u);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("an errno from the machine identity read is unresolvable state; an uncoded error rethrows", async () => {
    const f = await fixture();
    expect(await f.run({ machineId: () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); } }))
      .toMatchObject({ status: "refused", step: "S0", reason: "state-unresolvable", effectBegun: false, detail: expect.stringContaining("permission denied") });
    await expect(f.run({ machineId: () => { throw new Error("uncoded"); } })).rejects.toThrow("uncoded");
  });

  it("a member's identity storage failure does not mask a later member's checkpoint conflict", async () => {
    const f = await fixture();
    const [, b] = f.members;
    await crashAt(f, "after-checkpoint");
    f.deps.transferRows.set(b!.remoteProjectId, [{ run_id: "migration-copy-" + HASH_A, state: "completed" }]);
    let captures = 0;
    expect(await f.run({ captureDestinationIdentity: async () => { captures += 1; if (captures === 1) throw UNHEALTHY(); return { version: 1, ...f.deps.identity }; } }))
      .toMatchObject({ status: "interrupted", step: "S9", cause: "evidence-conflict", effectBegun: true, detail: expect.stringContaining("copy binding digest differs") });
  });
});

describe("activateCutoverSet: applied is derived from the live config and project map (#1673, #1617)", () => {
  const ZERO = "0".repeat(64);
  const unreadable = { readArtifact: () => null, readMaintenanceJournal: () => null } as const;
  const unresolvableBinding = (onCall: () => void) => ({
    bindings: { recordMigrationSelectionBinding: () => { onCall(); throw new MigrationBindingUnresolvableError("injected"); } },
  });

  /** A completed own publication whose project-map witness check then interrupts at S16. */
  async function afterPublication(f: Fixture, overrides: Parameters<Fixture["run"]>[0] = {}) {
    const witness = f.deps.computeProjectMapWitness;
    return f.run({
      computeProjectMapWitness: (request) => {
        if (request.mode !== "post-publication") return witness(request);
        throw new MigrationProjectMapWitnessError("project-map-drift", "injected drift", { drift: "entry-absent" });
      },
      ...overrides,
    });
  }

  /**
   * A held set at selection-completed (artifact loaded from the store) whose S13a binding write fails; the journal
   * readers report `view` from that moment on, which is what the interruption's applied readback sees.
   */
  async function viewed(f: Fixture, view: { maintenance?: unknown; publication?: unknown }, extra: Parameters<Fixture["run"]>[0] = {}) {
    let lie = false;
    const maintenance = f.deps.readMaintenanceJournal;
    const publication = f.deps.readPublicationJournal;
    return f.run({
      bindings: { ...f.deps.bindings, ...unresolvableBinding(() => { lie = true; }).bindings },
      readMaintenanceJournal: (h) => (lie ? (view.maintenance ?? null) as never : maintenance(h)),
      readPublicationJournal: (h) => (lie ? (view.publication ?? null) as never : publication(h)),
      ...extra,
    });
  }

  async function held() {
    const f = await fixture();
    await crashAt(f, "after-selection-completed");
    const live = f.deps.readSelectionDigests(f.homeDir);
    return { f, live, config: live.configSha256, map: live.projectMapSha256 };
  }

  const interruptedApplied = (applied: string) => ({ status: "interrupted", step: "S13a", applied });

  it("a completed own publication is yes while the live selection equals the published witnesses and unknown otherwise", async () => {
    const f = await fixture();
    expect(await afterPublication(f)).toMatchObject({ status: "interrupted", step: "S16", applied: "yes" });
    const g = await fixture();
    expect(await afterPublication(g, { readSelectionDigests: () => ({ configSha256: ZERO, projectMapSha256: ZERO }) })).toMatchObject({ status: "interrupted", step: "S16", applied: "unknown" });
    const h = await fixture();
    expect(await afterPublication(h, { readSelectionDigests: () => { throw new Error("readback failed"); } })).toMatchObject({ status: "interrupted", step: "S16", applied: "unknown" });
  });

  it("a yes-phase own journal needs both published witnesses to equal the live selection", async () => {
    const { f, config, map } = await held();
    for (const phase of ["config-published", "releasing", "released", "completed"]) {
      const own = (extra: object = {}) => ({ publicationId: f.setId, phase, publishedConfigSha256: config, publishedProjectMapSha256: map, ...extra });
      expect(await viewed(f, { publication: own() })).toMatchObject(interruptedApplied("yes"));
      expect(await viewed(f, { publication: own({ publishedConfigSha256: ZERO }) })).toMatchObject(interruptedApplied("unknown"));
      expect(await viewed(f, { publication: own({ publishedProjectMapSha256: ZERO }) })).toMatchObject(interruptedApplied("unknown"));
      expect(await viewed(f, { publication: own({ publishedConfigSha256: null }) })).toMatchObject(interruptedApplied("unknown"));
      expect(await viewed(f, { publication: own({ publishedProjectMapSha256: null }) })).toMatchObject(interruptedApplied("unknown"));
    }
  });

  it("an in-flight own phase is unknown even when the live selection equals the source", async () => {
    const { f, config, map } = await held();
    for (const phase of ["map-publishing", "map-published", "config-publishing"]) {
      expect(await viewed(f, { publication: { publicationId: f.setId, phase, expectedConfigSha256: config, expectedProjectMapSha256: map } })).toMatchObject(interruptedApplied("unknown"));
    }
  });

  it("a pre-publication or abort phase of the own journal is no only while the live selection equals the expected witnesses", async () => {
    const { f, config, map } = await held();
    for (const phase of ["preparing", "prepared", "acquiring", "guarded", "aborting", "config-restoring", "map-restoring", "abort-releasing", "aborted"]) {
      const own = (extra: object = {}) => ({ publicationId: f.setId, phase, expectedConfigSha256: config, expectedProjectMapSha256: map, ...extra });
      expect(await viewed(f, { publication: own() })).toMatchObject(interruptedApplied("no"));
      expect(await viewed(f, { publication: own({ expectedConfigSha256: ZERO }) })).toMatchObject(interruptedApplied("unknown"));
      expect(await viewed(f, { publication: own({ expectedProjectMapSha256: ZERO }) })).toMatchObject(interruptedApplied("unknown"));
    }
  });

  it("an own journal whose readback fails is unknown", async () => {
    const { f, config, map } = await held();
    const own = { publicationId: f.setId, phase: "completed", publishedConfigSha256: config, publishedProjectMapSha256: map };
    expect(await viewed(f, { publication: own }, { readSelectionDigests: () => { throw new Error("readback failed"); } })).toMatchObject(interruptedApplied("unknown"));
    let lie = false;
    const publication = f.deps.readPublicationJournal;
    expect(await f.run({
      bindings: { ...f.deps.bindings, ...unresolvableBinding(() => { lie = true; }).bindings },
      readPublicationJournal: (h) => { if (lie) throw new Error("journal read failed"); return publication(h); },
      readMaintenanceJournal: (h) => (lie ? null : f.deps.readMaintenanceJournal(h)),
    })).toMatchObject(interruptedApplied("unknown"));
  });

  it("a held sqlite window is no only while the live selection equals the artifact's source witness, and a window from another backend is unknown", async () => {
    const { f } = await held();
    const records = readCutoverSetActivationRecords({ homeDir: f.homeDir, setId: f.setId });
    if (records.state !== "resolved") throw new Error("records not resolved");
    const source = f.deps.readArtifact({ homeDir: f.homeDir, identityDigest: records.checkpoint!.identityDigest })!.source;
    const live = f.deps.readSelectionDigests(f.homeDir);
    expect(source.config.presence).toBe("present");
    expect(source.projectMap.presence).toBe("present");
    expect(live.configSha256).toBe(sha256((source.config as { content: Uint8Array }).content));
    expect(live.projectMapSha256).toBe(backendPublicationCanonicalSha256(JSON.parse(Buffer.from((source.projectMap as { content: Uint8Array }).content).toString("utf8"))));
    const resolved = { bindings: { ...f.deps.bindings, ...unresolvableBinding(() => undefined).bindings } };
    expect(await f.run(resolved)).toMatchObject(interruptedApplied("no"));
    expect(await f.run({ ...resolved, readSelectionDigests: () => ({ ...live, configSha256: ZERO }) })).toMatchObject(interruptedApplied("unknown"));
    expect(await f.run({ ...resolved, readSelectionDigests: () => ({ ...live, projectMapSha256: ZERO }) })).toMatchObject(interruptedApplied("unknown"));
    expect(await f.run({ ...resolved, readSelectionDigests: () => { throw new Error("readback failed"); } })).toMatchObject(interruptedApplied("unknown"));
    expect(await viewed(f, { maintenance: { ...f.journal()!, sourceBackend: "postgresql" } })).toMatchObject(interruptedApplied("unknown"));
  });

  it("an absent or foreign publication journal is no only while the live selection equals the artifact's source witness", async () => {
    const { f, live } = await held();
    for (const publication of [null, { publicationId: "other", phase: "completed" }]) {
      expect(await viewed(f, { publication })).toMatchObject(interruptedApplied("no"));
      expect(await viewed(f, { publication }, { readSelectionDigests: () => ({ ...live, projectMapSha256: ZERO }) })).toMatchObject(interruptedApplied("unknown"));
    }
  });

  it("an empty slot is no only while the live selection equals the artifact's source witness", async () => {
    const f = await fixture();
    await crashAt(f, "after-selection-completed");
    rmSync(backendPublicationJournalPath(f.homeDir));
    const binding = { bindings: { ...f.deps.bindings, ...unresolvableBinding(() => undefined).bindings } };
    expect(await f.run(binding)).toMatchObject(interruptedApplied("no"));
    expect(await f.run({ ...binding, readSelectionDigests: () => ({ configSha256: ZERO, projectMapSha256: ZERO }) })).toMatchObject(interruptedApplied("unknown"));
  });

  it("an absent or foreign publication journal without a source witness is unknown", async () => {
    const f = await fixture();
    await crashAt(f, "after-selection-completed");
    expect(await f.run({ ...unreadable, readPublicationJournal: () => null })).toMatchObject({ status: "interrupted", applied: "unknown" });
    expect(await f.run({ ...unreadable, readPublicationJournal: () => ({ publicationId: "other", phase: "completed" }) as never })).toMatchObject({ status: "interrupted", applied: "unknown" });
  });
});
