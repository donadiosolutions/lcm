import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackendPublicationCoordinator,
  readBackendMaintenanceJournal,
  resolveBackendMaintenanceGenerationBinding,
  withBackendPublicationAppendBarrierAsync,
  type BackendMaintenanceJournal,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";
import {
  assertMigrationReplayAdmission,
  authenticateSqliteMigrationSource,
  authenticateSqliteMigrationSourceBytes,
  captureAuthenticatedSqliteMigrationSource,
  inspectImmutableSqliteSnapshot,
  prepareSqliteMigrationEnrollment,
  resolveCutoverSetMemberAuthorities,
  type SqliteMigrationEnrollmentInput,
} from "../../src/migration/maintenance.js";
import {
  buildCutoverSetManifest,
  CutoverSetCaptureError,
  cutoverSetMaintenanceEntry,
} from "../../src/migration/cutover-set.js";
import * as coverageApi from "../../src/migration/activation-coverage.js";
import { performMigrationAbortCommand } from "../../src/migration/cli-abort.js";
import { SqliteSnapshotError, captureSqliteSnapshotArtifact } from "../../src/migration/sqlite-snapshot.js";
import { recordMigrationSelectionBinding } from "../../src/migration/generation-binding-store.js";
import { deriveActivationPublicationId } from "../../src/migration/activation-publication-id.js";
import { checkActivationWriterQuiescence } from "../../src/migration/activation-quiescence.js";
import { localProjectIdentity } from "../../src/daemon/project.js";
import { closeLcmConnection } from "../../src/db/connection.js";
import { clearProjectMapCache } from "../../src/project-map.js";
import * as identityApi from "../../src/machine-identity.js";
import type { IdentityRepository } from "../../src/identity-service.js";
import { SQLiteLocalHookOutboxFactory } from "../../src/storage/local-hook-outbox.js";
import { SqliteStorageBackendFactory } from "../../src/storage/sqlite/factory.js";
import { SET_ID, setManifest } from "../fixtures/cutover-set.js";

const REGISTERED_MACHINE = "018f0b5d-1234-7abc-8def-1234567890ab";
const HASH_B = "b".repeat(64);
const roots: string[] = [];

afterEach(() => {
  closeLcmConnection();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearProjectMapCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function coordinator(homeDir: string): BackendPublicationCoordinator {
  const unexpected = async (): Promise<never> => { throw new Error("v2 driver must not run for maintenance"); };
  const driver: BackendPublicationDriver = {
    observeLocalState: unexpected, publishProjectMap: unexpected, publishConfig: unexpected,
    restoreConfig: unexpected, restoreProjectMap: unexpected,
  };
  return new BackendPublicationCoordinator({ homeDir, driver });
}

type Project = Readonly<{ cwd: string; id: string; projectDir: string }>;

function prepareProject(homeDir: string, name: string): Project {
  const cwd = join(homeDir, name);
  mkdirSync(cwd, { mode: 0o700 });
  const local = localProjectIdentity(cwd, homeDir);
  const projectDir = join(homeDir, ".lcm", "projects", local.id);
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(projectDir, "meta.json"), JSON.stringify({ cwd }) + "\n", { mode: 0o600 });
  return { cwd, id: local.id, projectDir };
}

/** Two enrolled projects, each with a project database and a pending outbox event. */
async function twoProjectHome() {
  const homeDir = mkdtempSync(join(tmpdir(), "lcm-cutover-capture-"));
  mkdirSync(join(homeDir, ".lcm"), { mode: 0o700 });
  mkdirSync(join(homeDir, ".lcm", "events"), { mode: 0o700 });
  roots.push(homeDir);
  const projects = [prepareProject(homeDir, "project-a"), prepareProject(homeDir, "project-b")];
  const request: SqliteMigrationEnrollmentInput = {
    cwd: projects[0]!.cwd, homeDir, targetConfig: { backend: "postgresql", postgresql: {
      url: "postgresql://unused.invalid/lcm", caFile: "/unused", migrationRole: "unused",
      poolMax: 1, connectionTimeoutMs: 100, idleTimeoutMs: 100, statementTimeoutMs: 100,
    } },
  };
  const registered = () => {
    const pending = identityApi.readMachineIdentity(homeDir)!;
    return { machineId: REGISTERED_MACHINE, identityKey: pending.identityKey, displayName: pending.displayName };
  };
  const repository = { registerMachine: vi.fn(async () => registered()), recoverMachine: vi.fn(async () => registered()) };
  await prepareSqliteMigrationEnrollment(request, {
    openIdentitySession: async () => ({ repository: repository as unknown as IdentityRepository, close: async () => undefined }),
  });
  const second = projects[1]!;
  const factory = new SqliteStorageBackendFactory({ resolveProject: () => ({ id: second.id, dbPath: join(second.projectDir, "db.sqlite") }) });
  try { await (await factory.openProject({ id: second.id, canonical: second.cwd })).close(); } finally { await factory.close(); }
  const outboxes = new SQLiteLocalHookOutboxFactory();
  for (const project of projects) {
    const outbox = await outboxes.open(join(homeDir, ".lcm", "events", project.id + ".db"));
    await outbox.insertEvent("pending-" + project.id.slice(0, 4), { type: "decision", category: "decision", data: "pending " + project.id, priority: 1 }, "SessionStart");
  }
  await outboxes.close();
  closeLcmConnection();
  const sorted = [...projects].sort((left, right) => (left.id < right.id ? -1 : 1));
  return { homeDir, projects: sorted };
}

async function enterTwoProjectSet(homeDir: string) {
  return withBackendPublicationAppendBarrierAsync(homeDir, async (token) => {
    const resolution = resolveCutoverSetMemberAuthorities({ homeDir, lockToken: token });
    if (resolution.status !== "resolved") throw new Error("expected a resolved enumeration");
    const generationIds = new Map(resolution.outcomes.map((outcome, index) =>
      [outcome.physicalProjectId, "member-generation-" + String(index + 1)] as const));
    const built = buildCutoverSetManifest({ setId: SET_ID, machineId: REGISTERED_MACHINE, resolution, generationIds });
    if (built.status !== "built") throw new Error("expected a built set: " + JSON.stringify(built));
    const held = await coordinator(homeDir).enterMaintenance(built.entry, token);
    return { built, held, resolution };
  });
}

async function memberOptions(homeDir: string, held: BackendMaintenanceJournal, project: Project, generationId: string) {
  const authority = await withBackendPublicationAppendBarrierAsync(homeDir, (token) =>
    authenticateSqliteMigrationSource(project.cwd, homeDir, token));
  const expectedSourceBytes = await withBackendPublicationAppendBarrierAsync(homeDir, (token) =>
    authenticateSqliteMigrationSourceBytes(authority, { homeDir, lockToken: token }));
  return {
    authority,
    options: {
      homeDir,
      generationId,
      maintenanceChecksumSha256: resolveBackendMaintenanceGenerationBinding(held, generationId)!.checksumSha256,
      expectedSourceBytes,
    },
  };
}

describe("cutover-set member capture", () => {
  it("resolves an authenticated outcome for every stored-data project", async () => {
    const { homeDir, projects } = await twoProjectHome();
    const resolution = await withBackendPublicationAppendBarrierAsync(homeDir, async (token) =>
      resolveCutoverSetMemberAuthorities({ homeDir, lockToken: token }));
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.outcomes.map((outcome) => [outcome.physicalProjectId, outcome.status]))
      .toEqual(projects.map((project) => [project.id, "authenticated"]));
  });

  it("reports uncovered and unverifiable projects instead of omitting them", async () => {
    const { homeDir, projects } = await twoProjectHome();
    const resolve = () => withBackendPublicationAppendBarrierAsync(homeDir, async (token) =>
      resolveCutoverSetMemberAuthorities({ homeDir, lockToken: token }));
    // A stored-data directory the project map does not cover.
    const orphan = "f".repeat(64);
    mkdirSync(join(homeDir, ".lcm", "projects", orphan), { recursive: true, mode: 0o700 });
    writeFileSync(join(homeDir, ".lcm", "projects", orphan, "db.sqlite"), "");
    // A mapped hash whose canonical path authenticates a different project.
    const alias = "e".repeat(64);
    mkdirSync(join(homeDir, ".lcm", "projects", alias), { recursive: true, mode: 0o700 });
    writeFileSync(join(homeDir, ".lcm", "projects", alias, "db.sqlite"), "");
    const mapFile = join(homeDir, ".lcm", "map.json");
    const mapped: Record<string, unknown> = { [alias]: { canonical: projects[0]!.cwd, aliases: [] } };
    for (const project of projects) mapped[project.id] = { canonical: project.cwd, aliases: [] };
    writeFileSync(mapFile, JSON.stringify(mapped), { mode: 0o600 });
    // A mapped project whose metadata cannot be authenticated (group-readable file).
    chmodSync(join(projects[1]!.projectDir, "meta.json"), 0o644);
    clearProjectMapCache();
    const resolution = await resolve();
    if (resolution.status !== "resolved") throw new Error("expected a resolved enumeration");
    const byProject = new Map(resolution.outcomes.map((outcome) => [outcome.physicalProjectId, outcome]));
    expect(byProject.get(orphan)).toMatchObject({ status: "uncovered", detail: expect.stringContaining("no entry") });
    expect(byProject.get(alias)).toMatchObject({ status: "uncovered", detail: expect.stringContaining("different project") });
    expect(byProject.get(projects[1]!.id)).toMatchObject({ status: "unverifiable" });
    expect(byProject.get(projects[0]!.id)).toMatchObject({ status: "authenticated" });
    const built = buildCutoverSetManifest({
      setId: SET_ID, machineId: REGISTERED_MACHINE, resolution,
      generationIds: new Map(resolution.outcomes.map((o, i) => [o.physicalProjectId, "g" + String(i)] as const)),
    });
    expect(built).toMatchObject({ status: "refused", reason: "cutover-set-uncovered-member", projects: [alias, orphan].sort() });
  });

  it("surfaces an unresolvable enumeration with its own attribution", async () => {
    const { homeDir } = await twoProjectHome();
    vi.spyOn(coverageApi, "enumerateStoredDataProjectHashes").mockReturnValueOnce(
      { status: "unresolvable", reason: "events-directory-unresolvable", detail: "EACCES" });
    const resolution = await withBackendPublicationAppendBarrierAsync(homeDir, async (token) =>
      resolveCutoverSetMemberAuthorities({ homeDir, lockToken: token }));
    expect(resolution).toEqual({ status: "unresolvable", reason: "events-directory-unresolvable", detail: "EACCES" });
  });

  it("captures every member under one hold, each bound to its own checksum and cutoff", async () => {
    const { homeDir, projects } = await twoProjectHome();
    const { held } = await enterTwoProjectSet(homeDir);
    const [genA, genB] = held.cutoverSet!.manifest.members.map((member) => member.generationId) as [string, string];
    const sourceA = await memberOptions(homeDir, held, projects[0]!, genA);
    const sourceB = await memberOptions(homeDir, held, projects[1]!, genB);
    const entryChecksumB = sourceB.options.maintenanceChecksumSha256;

    const snapshotA = await captureAuthenticatedSqliteMigrationSource(sourceA.authority, sourceA.options);
    const afterA = readBackendMaintenanceJournal(homeDir)!;
    const viewAAfterA = resolveBackendMaintenanceGenerationBinding(afterA, genA)!;
    // Member B's entry checksum survives member A's rebind.
    expect(resolveBackendMaintenanceGenerationBinding(afterA, genB)!.checksumSha256).toBe(entryChecksumB);

    const snapshotB = await captureAuthenticatedSqliteMigrationSource(sourceB.authority, sourceB.options);
    const afterB = readBackendMaintenanceJournal(homeDir)!;
    const viewAAfterB = resolveBackendMaintenanceGenerationBinding(afterB, genA)!;
    const viewBAfterB = resolveBackendMaintenanceGenerationBinding(afterB, genB)!;
    expect(viewAAfterB.checksumSha256).toBe(viewAAfterA.checksumSha256);

    // The top-level roster stays the immutable set sentinel; the evidence is per member.
    expect(afterB.roster).toEqual(held.roster);
    expect(afterB.roster[0]!.queueCutoff).toBeNull();
    expect(viewAAfterB.roster[0]!.queueCutoff).toBe(snapshotA.receiptReference.queueCutoff);
    expect(viewBAfterB.roster[0]!.queueCutoff).toBe(snapshotB.receiptReference.queueCutoff);
    expect(viewAAfterB.roster[0]!.evidenceSha256).not.toBe(viewBAfterB.roster[0]!.evidenceSha256);
    expect(afterB.queueEvidenceSha256).not.toBe(viewAAfterB.queueEvidenceSha256);
    expect(afterB.queueEvidenceSha256).not.toBe(viewBAfterB.queueEvidenceSha256);
    for (const [generationId, snapshot, view] of [[genA, snapshotA, viewAAfterB], [genB, snapshotB, viewBAfterB]] as const) {
      expect(snapshot.receiptReference.maintenanceChecksumSha256).toBe(view.checksumSha256);
      const witness = await inspectImmutableSqliteSnapshot(generationId, homeDir);
      expect(witness.maintenanceChecksumSha256).toBe(view.checksumSha256);
      expect(witness.queueEvidenceSha256).toBe(view.queueEvidenceSha256);
      expect(witness.queueEvidenceSha256).not.toBe(afterB.queueEvidenceSha256);
    }

    // Member A stays usable after member B was captured: the existing-artifact branch recaptures it.
    const recapture = await captureAuthenticatedSqliteMigrationSource(sourceA.authority, {
      ...sourceA.options, maintenanceChecksumSha256: viewAAfterB.checksumSha256,
    });
    expect(recapture.receiptReference).toEqual(snapshotA.receiptReference);
    // The journal checksum is no member's binding.
    await expect(captureAuthenticatedSqliteMigrationSource(sourceA.authority, {
      ...sourceA.options, maintenanceChecksumSha256: afterB.checksumSha256,
    })).rejects.toThrow("authority changed");
    expect(readBackendMaintenanceJournal(homeDir)).toEqual(afterB);
  });

  it("refuses a request that is not a member of the held set, with a typed error", async () => {
    const { homeDir, projects } = await twoProjectHome();
    const { held } = await enterTwoProjectSet(homeDir);
    const [genA, genB] = held.cutoverSet!.manifest.members.map((member) => member.generationId) as [string, string];
    const sourceA = await memberOptions(homeDir, held, projects[0]!, genA);
    const unbound = (options: typeof sourceA.options, authority = sourceA.authority) =>
      captureAuthenticatedSqliteMigrationSource(authority, options).catch((error: unknown) => error);
    const stranger = await unbound({ ...sourceA.options, generationId: "stranger-generation" });
    expect(stranger).toBeInstanceOf(CutoverSetCaptureError);
    expect(stranger).toMatchObject({ reason: "cutover-set-member-unbound" });
    const wrongAuthority = await unbound({ ...sourceA.options, generationId: genB });
    expect(wrongAuthority).toMatchObject({ reason: "cutover-set-member-unbound" });
    expect(readBackendMaintenanceJournal(homeDir)).toEqual(held);
  });

  it("refuses membership drift and an unresolvable enumeration under the hold", async () => {
    const { homeDir, projects } = await twoProjectHome();
    const { held } = await enterTwoProjectSet(homeDir);
    const genA = held.cutoverSet!.manifest.members[0]!.generationId;
    const sourceA = await memberOptions(homeDir, held, projects[0]!, genA);

    vi.spyOn(coverageApi, "enumerateStoredDataProjectHashes").mockReturnValueOnce(
      { status: "unresolvable", reason: "projects-directory-unresolvable", detail: "EACCES" });
    await expect(captureAuthenticatedSqliteMigrationSource(sourceA.authority, sourceA.options))
      .rejects.toMatchObject({ reason: "cutover-set-enumeration-unresolvable" });
    vi.restoreAllMocks();

    const third = prepareProject(homeDir, "project-c");
    // Creating an outbox is refused under the hold; a data file alone is what enumeration counts.
    new DatabaseSync(join(homeDir, ".lcm", "events", third.id + ".db")).close();
    const error = await captureAuthenticatedSqliteMigrationSource(sourceA.authority, sourceA.options).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CutoverSetCaptureError);
    expect(error).toMatchObject({ reason: "cutover-set-membership-drift", projects: [third.id] });
    expect(readBackendMaintenanceJournal(homeDir)).toEqual(held);

    // The enumeration reconciled the project map, so the old source authority no longer matches any member.
    const refreshed = await memberOptions(homeDir, held, projects[0]!, genA);
    await expect(captureAuthenticatedSqliteMigrationSource(refreshed.authority, refreshed.options))
      .rejects.toMatchObject({ reason: "cutover-set-member-unbound" });
  });

  it("refuses membership drift when a member loses its stored data", async () => {
    const { homeDir, projects } = await twoProjectHome();
    const { held } = await enterTwoProjectSet(homeDir);
    const genA = held.cutoverSet!.manifest.members[0]!.generationId;
    const sourceA = await memberOptions(homeDir, held, projects[0]!, genA);
    rmSync(join(projects[1]!.projectDir, "db.sqlite"), { force: true });
    rmSync(join(homeDir, ".lcm", "events", projects[1]!.id + ".db"), { force: true });
    rmSync(join(homeDir, ".lcm", "events", projects[1]!.id + ".db-wal"), { force: true });
    rmSync(join(homeDir, ".lcm", "events", projects[1]!.id + ".db-shm"), { force: true });
    await expect(captureAuthenticatedSqliteMigrationSource(sourceA.authority, sourceA.options))
      .rejects.toMatchObject({ reason: "cutover-set-membership-drift", projects: [projects[1]!.id] });
    expect(readBackendMaintenanceJournal(homeDir)).toEqual(held);
  });

  it("refuses a snapshot when no maintenance hold exists", async () => {
    const { homeDir, projects } = await twoProjectHome();
    const authority = await withBackendPublicationAppendBarrierAsync(homeDir, (token) =>
      authenticateSqliteMigrationSource(projects[0]!.cwd, homeDir, token));
    const expectedSourceBytes = await withBackendPublicationAppendBarrierAsync(homeDir, (token) =>
      authenticateSqliteMigrationSourceBytes(authority, { homeDir, lockToken: token }));
    await expect(captureSqliteSnapshotArtifact(authority, {
      homeDir, generationId: "member-generation-1", maintenanceChecksumSha256: HASH_B, expectedSourceBytes,
    })).rejects.toBeInstanceOf(SqliteSnapshotError);
  });

  it("lets an operator release a captured set hold through the migration abort command", async () => {
    const { homeDir, projects } = await twoProjectHome();
    const { held } = await enterTwoProjectSet(homeDir);
    const members = held.cutoverSet!.manifest.members;
    for (const [index, member] of members.entries()) {
      const source = await memberOptions(homeDir, readBackendMaintenanceJournal(homeDir)!, projects[index]!, member.generationId);
      await captureAuthenticatedSqliteMigrationSource(source.authority, source.options);
    }
    const captured = readBackendMaintenanceJournal(homeDir)!;
    expect(captured.cutoverSet!.bindings.every((binding) => binding.roster[0]!.queueCutoff !== null)).toBe(true);
    // Neither the set id nor a member has a manifest or snapshot of its own; the held journal names the set id.
    expect(await performMigrationAbortCommand({ homeDir, confirmGenerationId: "wrong-set", generation: SET_ID }))
      .toEqual({ status: "refuse", reason: "abort-confirmation-moved", generationId: SET_ID });
    expect(readBackendMaintenanceJournal(homeDir)).toEqual(captured);
    expect(await performMigrationAbortCommand({ homeDir, confirmGenerationId: SET_ID }))
      .toEqual({ status: "ok", generationId: SET_ID, journalPhase: "maintenance-aborted", manifestPhase: null, applied: true });
    const aborted = readBackendMaintenanceJournal(homeDir)!;
    expect(aborted).toMatchObject({ phase: "maintenance-aborted", sourceBackend: "sqlite", generationId: SET_ID });
    expect(aborted.cutoverSet).toEqual(captured.cutoverSet);
  });
});

describe("cutover-set gates", () => {
  async function setHome() {
    const homeDir = mkdtempSync(join(tmpdir(), "lcm-cutover-gates-"));
    mkdirSync(join(homeDir, ".lcm"), { mode: 0o700 });
    roots.push(homeDir);
    const entry = cutoverSetMaintenanceEntry(setManifest(2));
    const held = await coordinator(homeDir).enterMaintenance({ ...entry, now: new Date("2026-10-20T00:00:00.000Z") });
    return { homeDir, held };
  }

  it("refuses replay for every generation while the set hold is live, before any historical binding", async () => {
    const { homeDir, held } = await setHome();
    const member = held.cutoverSet!.manifest.members[0]!.generationId;
    recordMigrationSelectionBinding({
      homeDir, generationId: member,
      binding: { kind: "activation", epochId: "epoch-1", attemptId: "attempt-1", manifestRevision: 5, witnessChecksumSha256: HASH_B, publicationId: deriveActivationPublicationId(member) },
    });
    for (const generationId of [member, "unrelated-generation", SET_ID]) {
      expect(() => assertMigrationReplayAdmission({ homeDir, generationId, evidenceSha256: HASH_B }))
        .toThrow("no authoritative terminal");
    }
    await coordinator(homeDir).abortMaintenance({
      expectedChecksumSha256: held.checksumSha256, sourceSelectionSha256: held.sourceSelectionSha256, abortEvidenceSha256: HASH_B,
    });
    // After the abort the member's historical binding decides, as for any generation.
    expect(assertMigrationReplayAdmission({ homeDir, generationId: member, evidenceSha256: HASH_B }))
      .toEqual({ backend: "postgresql", disposition: "selected" });
  });

  it("reports unsupported writer quiescence for a set hold", async () => {
    const { homeDir } = await setHome();
    const pending = identityApi.ensurePendingMachineIdentity("Test Machine", homeDir).identity;
    identityApi.finalizeMachineIdentity(pending, REGISTERED_MACHINE, "Test Machine", homeDir);
    const result = await withBackendPublicationAppendBarrierAsync(homeDir, (token) =>
      checkActivationWriterQuiescence({ homeDir, lockToken: token }));
    expect(result).toMatchObject({ status: "unsatisfied", reason: "cutover-set-unsupported", quiescenceFence: null });
  });
});
