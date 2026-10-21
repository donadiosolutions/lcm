import { expect } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../../src/db/migration.js";
import type { ResolvedStorageConfig } from "../../src/daemon/config.js";
import { lcmHomeDir } from "../../src/runtime-paths.js";
import { projectMapPath } from "../../src/project-map.js";
import { readBackendMaintenanceJournal, readBackendPublicationJournal } from "../../src/storage/backend-publication.js";
import { canonicalSha256, PORTABLE_RECORD_DOMAIN_ORDER } from "../../src/storage/portable-record.js";
import { openSqlitePortableSource, sqlitePortableFileSha256 } from "../../src/storage/sqlite/portable-source.js";
import type { PostgreSqlSnapshotSession } from "../../src/storage/postgresql/snapshot-session.js";
import { migrationWitnessSha256 } from "../../src/migration/activation-witness.js";
import { readCutoverSetActivationRecords, type CutoverSetActivationCheckpoint } from "../../src/migration/cutover-set-activation-store.js";
import {
  createCutoverSetRollbackDependencies,
  rollbackCutoverSet,
  type CutoverSetRollbackDependencies,
  type CutoverSetRollbackInput,
  type CutoverSetRollbackResult,
} from "../../src/migration/cutover-set-rollback.js";
import { deriveCutoverSetRollbackSetId, readCutoverSetRollbackRecords } from "../../src/migration/cutover-set-rollback-store.js";
import { resolveMigrationWitnessBindings } from "../../src/migration/generation-binding-store.js";
import { assertMigrationReplayAdmission } from "../../src/migration/maintenance.js";
import { readRollbackReport } from "../../src/migration/rollback.js";
import { DEFAULT_ROLLBACK_SESSION_DEPENDENCIES, type RollbackSessionDependencies, type RollbackSessionRuntime } from "../../src/migration/rollback-session.js";
import type { AuthenticatedSqliteMigrationSnapshot } from "../../src/migration/queue-evidence.js";
import type { MigrationVerificationDomainCensus } from "../../src/migration/verify-generation.js";
import { fixtureSchemaWitness } from "../fixtures/migration-activation-records.js";
import {
  DEST_IDENTITY, MACHINE, READINESS, SYSTEM_ID, TARGET_CONFIG, domainCensus, expectActivated, fixture, roots,
  type Fixture, type FixtureMember, type FixtureOptions,
} from "./cutover-set-activate-fixture.js";

/**
 * A real two-project home activated through the #1549 fixture (real
 * manifest, report, evidence, binding, artifact and set record stores, real
 * coordinator over the real driver and the real PostgreSQL remote guard
 * provider over an in-memory lease guard), rolled back through
 * rollbackCutoverSet with the real set member sessions over a fake runtime:
 * the PostgreSQL reads (identity, schema, census, export) are faked per
 * member, every local store, the hold, the cutoffs, the set quiescence, the
 * recovery admission, the build, the install, the sidecars, the records,
 * the selection and the reverse publication are real.
 */

export type MemberMode = "pre-write" | "post-write";

export type RollbackFixture = Readonly<{
  activation: Fixture;
  homeDir: string;
  originalSetId: string;
  setId: string;
  members: readonly FixtureMember[];
  checkpoint: CutoverSetActivationCheckpoint;
  modes: Map<string, MemberMode>;
  /** The destination census the live readback reports per remote project; defaults from the mode. */
  liveCensus: Map<string, MigrationVerificationDomainCensus[]>;
  /** The export's census per remote project; defaults to the live census. */
  exportCensus: Map<string, MigrationVerificationDomainCensus[]>;
  identity: { sealedWitnessSha256: string; systemIdentifier: string };
  snapshotOverride: Map<string, Partial<AuthenticatedSqliteMigrationSnapshot["artifact"]>>;
  runtime: RollbackSessionRuntime & { closes: number };
  deps: CutoverSetRollbackDependencies & { prepareCalls: number; composeCalls: number };
  input: CutoverSetRollbackInput;
  run: (overrides?: Partial<CutoverSetRollbackDependencies>) => Promise<CutoverSetRollbackResult>;
}>;

export function sqliteDatabase(path: string): string {
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  try { runLcmMigrations(db, { fts5Available: false }); } finally { db.close(); }
  chmodSync(path, 0o600);
  return path;
}

const PRESERVED_IDENTITY_FACTS = { machines: [{ identityKey: "local-machine", machineId: null }], aliases: [] };
const factsFor = (localProjectId: string) => ({ ...PRESERVED_IDENTITY_FACTS, sourceLocalProjectId: localProjectId });

/** A real SQLite portable source over a fresh migrated database (the preserved snapshot or the PostgreSQL export stand-in). */
export async function sqliteSource(remoteProjectId: string, localProjectId: string, scratch: string) {
  const dir = mkdtempSync(join(tmpdir(), "lcm-set-rollback-src-"));
  roots.push(dir);
  const path = sqliteDatabase(join(dir, "source.db"));
  const facts = factsFor(localProjectId);
  return openSqlitePortableSource({
    databasePath: path, scratchParent: scratch, projectIdentity: { scope: "shared", projectId: remoteProjectId }, sourceLocalProjectId: localProjectId,
    identityFacts: facts, expectedFileSha256: sqlitePortableFileSha256(path), expectedFactsSha256: canonicalSha256(facts),
    capturedAt: "2026-10-16T11:00:00.000000Z",
    capturedSidecars: { events: { absent: true, evidenceSha256: "f".repeat(64) }, instructions: { absent: true, evidenceSha256: "e".repeat(64) } },
  });
}

export function baselineCensus(member: FixtureMember): MigrationVerificationDomainCensus[] {
  return domainCensus("census-" + member.localProjectId.slice(0, 4));
}

export function driftedCensus(member: FixtureMember): MigrationVerificationDomainCensus[] {
  return domainCensus("drift-" + member.localProjectId.slice(0, 4));
}

export type RollbackFixtureOptions = FixtureOptions & Readonly<{
  modes?: readonly MemberMode[];
  /** Leave the activation's post-publication bookkeeping pending for these member indexes (crash after the drive). */
  pendingActivation?: readonly number[];
}>;

export async function rollbackFixture(options: RollbackFixtureOptions = {}): Promise<RollbackFixture> {
  const activation = await fixture(options);
  const { homeDir, members } = activation;
  for (const member of members) sqliteDatabase(join(lcmHomeDir(homeDir), "projects", member.localProjectId, "db.sqlite"));
  const pending = new Set((options.pendingActivation ?? []).map((index) => members[index]!.generationId));
  if (pending.size > 0) {
    const first = [...pending][0]!;
    await expect(activation.run({ crashPoint: (point) => { if (point === "after-drive" ) throw new Error("crash at after-drive"); } })).rejects.toThrow("crash at after-drive");
    expect(first).toBeDefined();
  } else {
    expectActivated(activation, await activation.run(), "fresh");
  }
  const records = readCutoverSetActivationRecords({ homeDir, setId: activation.setId });
  if (records.state !== "resolved" || records.selection === null) throw new Error("the activation records are not frozen");
  const modes = new Map(members.map((member, index) => [member.remoteProjectId, options.modes?.[index] ?? (index % 2 === 0 ? "pre-write" : "post-write")]));
  const liveCensus = new Map(members.map((member) => [member.remoteProjectId, modes.get(member.remoteProjectId) === "pre-write" ? baselineCensus(member) : driftedCensus(member)]));
  const exportCensus = new Map<string, MigrationVerificationDomainCensus[]>();
  const identity = { sealedWitnessSha256: DEST_IDENTITY, systemIdentifier: SYSTEM_ID };
  const snapshotOverride = new Map<string, Partial<AuthenticatedSqliteMigrationSnapshot["artifact"]>>();
  const runtime = {
    closes: 0,
    backendPublicationGuard: () => activation.guard,
    openReadOnlySnapshot: async () => ({ query: async () => ({ rows: [] }), close: async () => undefined }) as unknown as PostgreSqlSnapshotSession,
    close: async () => { runtime.closes += 1; },
  } as RollbackSessionRuntime & { closes: number };
  const scratch = mkdtempSync(join(tmpdir(), "lcm-set-rollback-scratch-"));
  roots.push(scratch);
  const sessionDependencies: RollbackSessionDependencies = {
    ...DEFAULT_ROLLBACK_SESSION_DEPENDENCIES,
    createRuntime: () => { throw new Error("the set service owns the one runtime"); },
    verifyRuntimeSchema: async () => READINESS,
    assertReadOnlyGuard: async () => undefined,
    captureDestinationIdentity: async () => ({ version: 1, ...identity }),
    captureDestinationSchemaWitness: async () => fixtureSchemaWitness("schema"),
    readFencedDestinationCensus: async (_snapshot, request) => ({
      census: liveCensus.get(request.expectedIdentity.remoteProjectId!)!, dependencyEdges: new Map(), recordIdentities: new Map(), recordSha256s: new Map(),
    }),
    createPortableSource: async (request) => sqliteSource(request.expectedIdentity.remoteProjectId!, request.expectedIdentity.localProjectId!, scratch) as never,
    readDomainCensus: ((source: { describe?: () => unknown }, domain: string) => {
      const remote = members.find((member) => (exportCensus.get(member.remoteProjectId) ?? liveCensus.get(member.remoteProjectId)) !== undefined && currentExport === member.remoteProjectId)!;
      void source;
      return (exportCensus.get(remote.remoteProjectId) ?? liveCensus.get(remote.remoteProjectId))!.find((entry) => entry.domain === domain)!;
    }) as never,
    renewalIntervalMs: 60_000,
  };
  let currentExport = "";
  const base = createCutoverSetRollbackDependencies({ homeDir });
  const deps: RollbackFixture["deps"] = {
    ...base,
    prepareCalls: 0, composeCalls: 0,
    machineId: () => MACHINE,
    readStorageConfig: (dir) => {
      const raw = JSON.parse(readFileSync(join(lcmHomeDir(dir), "config.json"), "utf8")) as { storage: { backend: string } };
      return (raw.storage.backend === "sqlite" ? { backend: "sqlite" } : TARGET_CONFIG) as ResolvedStorageConfig;
    },
    parseSealedStorageConfig: (content) => {
      const raw = JSON.parse(Buffer.from(content).toString("utf8")) as { storage: { backend: string } };
      return (raw.storage.backend === "sqlite" ? { backend: "sqlite" } : TARGET_CONFIG) as ResolvedStorageConfig;
    },
    createRuntime: () => runtime,
    verifyRuntimeSchema: async () => READINESS,
    sessionDependencies,
    createCoordinator: () => {
      const real = activation.coordinator();
      const prepare = real.prepare.bind(real);
      real.prepare = (async (request: Parameters<typeof prepare>[0], token: Parameters<typeof prepare>[1]) => { deps.prepareCalls += 1; return prepare(request, token); }) as typeof real.prepare;
      return real;
    },
    composeMaterial: (request) => { deps.composeCalls += 1; return base.composeMaterial(request); },
    inspectSnapshot: async (generationId) => {
      const member = members.find((candidate) => candidate.generationId === generationId)!;
      const row = records.checkpoint.members.find((candidate) => candidate.generationId === generationId)!;
      const artifact = {
        generationId, maintenanceChecksumSha256: row.heldMemberChecksumSha256,
        authority: { physicalProjectId: member.localProjectId, machineIdentity: { identityKey: "key", machineId: MACHINE }, projectDbPath: join(lcmHomeDir(homeDir), "projects", member.localProjectId, "db.sqlite") },
        sourceSelectionSha256: migrationWitnessSha256(["source-selection", member.localProjectId]),
        queueEvidenceSha256: migrationWitnessSha256(["queue", member.localProjectId]),
        sourceByteWitnessSha256: migrationWitnessSha256(["bytes", member.localProjectId]),
        ...snapshotOverride.get(generationId),
      };
      return {
        version: 1, artifact, receiptReference: { queueCutoff: "000000000000000000" + String(member.index + 1) }, pages: [], evidenceDirectory: { dev: "1", ino: "1" },
        checksumSha256: migrationWitnessSha256(["snapshot", generationId, JSON.stringify(artifact)]),
      } as unknown as AuthenticatedSqliteMigrationSnapshot;
    },
    derivePreservedSource: (snapshot, expectedIdentity) => {
      const member = members.find((candidate) => candidate.generationId === snapshot.artifact.generationId)!;
      const manifest = activation.manifestStore.read(member.generationId);
      expect(expectedIdentity.remoteProjectId).toBe(member.remoteProjectId);
      return {
        facts: factsFor(member.localProjectId) as never, extraInstructionAbsenceSha256: "e".repeat(64), sourceWitness: manifest.source,
        open: async () => sqliteSource(member.remoteProjectId, member.localProjectId, scratch),
      };
    },
    openMemberSession: (request, target, dependencies) => {
      currentExport = target.remoteProjectId;
      const open = base.openMemberSession(request, target, dependencies);
      return open.then((session) => {
        const openPortableSource = session.openPortableSource.bind(session);
        session.openPortableSource = async () => { currentExport = target.remoteProjectId; return openPortableSource(); };
        return session;
      });
    },
    renewalIntervalMs: 60_000,
    leaseCleanupTimeoutMs: 1000,
  };
  const input: CutoverSetRollbackInput = { homeDir, confirmSetId: activation.setId, scratchParent: scratch, now: () => new Date("2026-10-21T10:00:00.000Z") };
  return {
    activation, homeDir, originalSetId: activation.setId, setId: deriveCutoverSetRollbackSetId(activation.setId), members, checkpoint: records.checkpoint,
    modes, liveCensus, exportCensus, identity, snapshotOverride, runtime, deps, input,
    run: (overrides = {}) => rollbackCutoverSet(input, { ...deps, ...overrides }),
  };
}

/** The effective home: the config backend and every member's map binding; never one project on each backend. */
export function effectiveHome(f: RollbackFixture): Readonly<{ backend: string; bound: readonly boolean[] }> {
  const config = JSON.parse(readFileSync(join(lcmHomeDir(f.homeDir), "config.json"), "utf8")) as { storage: { backend: string } };
  const map = JSON.parse(readFileSync(projectMapPath(f.homeDir), "utf8")) as Record<string, { remoteProjectId?: string }>;
  return { backend: config.storage.backend, bound: f.members.map((member) => map[member.localProjectId]?.remoteProjectId === member.remoteProjectId) };
}

export function expectAllPostgreSql(f: RollbackFixture): void {
  expect(effectiveHome(f)).toEqual({ backend: "postgresql", bound: f.members.map(() => true) });
}

export function expectAllSqlite(f: RollbackFixture): void {
  expect(effectiveHome(f)).toEqual({ backend: "sqlite", bound: f.members.map(() => false) });
}

export function expectNotMixed(f: RollbackFixture): void {
  const home = effectiveHome(f);
  const bound = home.bound.filter(Boolean).length;
  expect(bound === 0 || bound === f.members.length).toBe(true);
}

export function canonicalSha(f: RollbackFixture, member: FixtureMember): string {
  const path = join(lcmHomeDir(f.homeDir), "projects", member.localProjectId, "db.sqlite");
  return canonicalSha256(readFileSync(path).toString("base64"));
}

export function expectRolledBack(f: RollbackFixture, outcome: CutoverSetRollbackResult, resumedFrom: string): void {
  expect(outcome.status, JSON.stringify(outcome)).toBe("rolled-back");
  if (outcome.status !== "rolled-back") return;
  expect(outcome.resumedFrom).toBe(resumedFrom);
  expect(outcome).toMatchObject({ originalSetId: f.originalSetId, setId: f.setId, publicationId: f.setId });
  expectAllSqlite(f);
  const v2 = readBackendPublicationJournal(f.homeDir);
  expect(v2).toMatchObject({ phase: "completed", publicationId: f.setId, sourceBackend: "postgresql", targetBackend: "sqlite" });
  expect(v2!.projects.map((project) => project.localProjectId)).toEqual(f.members.map((member) => member.localProjectId));
  expect(readBackendMaintenanceJournal(f.homeDir)).toBeNull();
  const records = readCutoverSetRollbackRecords({ homeDir: f.homeDir, originalSetId: f.originalSetId });
  expect(records.state).toBe("resolved");
  if (records.state !== "resolved") return;
  expect(records.selection).not.toBeNull();
  for (const [index, member] of f.members.entries()) {
    const row = records.selection!.members[index]!;
    expect(row.generationId).toBe(member.generationId);
    expect(row.mode).toBe(f.modes.get(member.remoteProjectId));
    expect(outcome.members[index]).toMatchObject({ generationId: member.generationId, mode: row.mode, installedGenerationId: records.installs.get(member.generationId)!.installedGenerationId, manifest: "rolled-back" });
    const manifest = f.activation.manifestStore.read(member.generationId);
    expect(manifest.phase).toBe("rolled-back");
    expect(manifest.pendingEffect).toBeNull();
    expect(manifest.rollbackLineage.mode).toBe(row.mode);
    const ref = manifest.reports.filter((report) => report.kind === "rollback").at(-1)!;
    const report = readRollbackReport(f.homeDir, member.generationId, ref.reportId);
    expect(report).toMatchObject({ kind: "rollback", mode: row.mode, effectId: "rollback-publish-" + row.witnessChecksumSha256, epochId: row.epochId, attemptId: row.attemptId });
    const bindings = resolveMigrationWitnessBindings({ homeDir: f.homeDir, generationId: member.generationId });
    expect(bindings).toMatchObject({ state: "resolved" });
    if (bindings.state === "resolved") {
      expect(bindings.selections.at(-1)).toEqual(expect.objectContaining({ kind: "rollback", publicationId: f.setId, witnessChecksumSha256: row.witnessChecksumSha256 }));
    }
    const install = records.installs.get(member.generationId)!;
    const path = join(lcmHomeDir(f.homeDir), "projects", member.localProjectId, "db.sqlite");
    expect(statSync(path).size.toString()).toBe(install.database.size);
    // The preempted original is preserved read-only beside the installed candidate.
    expect(install.preemption).not.toBeNull();
    expect(statSync(install.preemption!.path).mode & 0o777).toBe(0o400);
    expect(assertMigrationReplayAdmission({ homeDir: f.homeDir, generationId: member.generationId, evidenceSha256: row.witnessChecksumSha256 })).toEqual({ backend: "sqlite", disposition: "selected" });
    expect(f.activation.guard.rows.get(member.remoteProjectId)?.releasedAt).not.toBeNull();
  }
}

export function writeConfig(homeDir: string, backend: string): void {
  writeFileSync(join(lcmHomeDir(homeDir), "config.json"), JSON.stringify({ storage: { backend }, daemon: { port: 4321 } }) + "\n", { mode: 0o600 });
}

