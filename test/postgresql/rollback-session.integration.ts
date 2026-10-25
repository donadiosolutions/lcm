/**
 * The production rollback against a real PostgreSQL 18 database: a real
 * lease on lcm.fenced_leases, real read-only snapshots, the real census and
 * export, and the REAL coordinator over the production driver and the
 * PostgreSQL remote guard. The first-open quiescence (a local append-barrier
 * concern with its own tests) is the one collaborator satisfied by a stand-in;
 * every recovery open runs the REAL recovery admission over the real journals
 * (#626 F11). The resolved context (the preserved-source snapshot evidence and
 * machine identity) is supplied, since those belong to the forward migration.
 *
 * The cases drive runMigrationRollbackFromHome, the entry #627 will call, over
 * an installation whose activation was itself published through the real
 * coordinator (config.json and the project map are real files, the retained
 * activation publication is read back, the evidence and binding stores hold
 * the activation's records). They prove: pre-write and post-write
 * rollbacks complete and publish sqlite, and a generation that never
 * activated is refused before anything is written; replay admission then
 * routes to sqlite from the selection binding; the released activation lease
 * row is replaced while an unreleased one refuses; a crash after the
 * coordinator's prepare and after its config publish resume through
 * coordinator.resume; two remotely bound projects refuse; and the
 * build-versus-revalidation equality of plan-v3.1 amendments A6 and A17.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  readBackendMaintenanceJournal,
  readBackendPublicationJournal,
} from "../../src/storage/backend-publication.js";
import { createBackendPublicationCoordinator } from "../../src/storage/backend-publication-driver.js";
import { composeBackendPublicationMaterial } from "../../src/storage/backend-publication-material.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import { acquirePostgreSqlProjectMutationGuard } from "../../src/storage/postgresql/publication-guard.js";
import { createPostgreSqlBackendPublicationRemoteGuard } from "../../src/storage/postgresql/publication-remote-guard.js";
import { configPath } from "../../src/runtime-paths.js";
import { clearProjectMapCache, projectMapPath } from "../../src/project-map.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import {
  recordMigrationActivationAttempt,
  recordMigrationActivationEpoch,
  recordMigrationActivationWitness,
} from "../../src/migration/activation-evidence-store.js";
import {
  recordMigrationSelectionBinding,
  recordMigrationWitnessBinding,
  resolveMigrationWitnessBindings,
} from "../../src/migration/generation-binding-store.js";
import { assertMigrationReplayAdmission } from "../../src/migration/maintenance.js";
import { drainIntoPrunedState, forgetLocalPrune, readDeliveryRows } from "./drained-inbox-fixture.js";
import {
  beginMigrationEffect,
  completeMigrationEffect,
  createMigrationManifest,
  type MigrationManifest,
  type MigrationStorageWitness,
} from "../../src/migration/protocol.js";
import { deriveRollbackPublicationId, runMigrationRollback } from "../../src/migration/rollback.js";
import {
  DEFAULT_RESOLVE_ROLLBACK_CONTEXT_DEPENDENCIES,
  runMigrationRollbackFromHome,
  type RollbackEntryDependencies,
} from "../../src/migration/rollback-inputs.js";
import {
  DEFAULT_ROLLBACK_SESSION_DEPENDENCIES,
  RollbackSessionError,
  openRollbackFencedSession,
  type RollbackSessionDependencies,
  type RollbackSessionTarget,
} from "../../src/migration/rollback-session.js";
import {
  buildMigrationCanonicalDelta,
  buildMigrationCensusVector,
  captureDestinationIdentity,
  readFencedDestinationCensus,
} from "../../src/migration/verify-generation.js";
import { fixtureActivationScenario } from "../fixtures/migration-activation-records.js";
import { assertHarnessReady, settings, withPostgreSqlTestDatabase, type PostgreSqlTestDatabase } from "./harness.js";
import { applyAllRuntimeGrants } from "./operational-fixture.js";
import { PORTABLE_POSTGRESQL_FIXTURE, seedPortablePostgreSql } from "./portable-fixture.js";
import { eventsDir } from "../../src/db/events-path.js";
import { readOutboxPrevEventIds, replicateIntoInbox } from "./replicated-inbox-fixture.js";

beforeAll(assertHarnessReady);

const fixture = PORTABLE_POSTGRESQL_FIXTURE;
const factoryContext = { domain: "factory", operation: "rollbackSessionIntegration" } as const;
const capturedAt = "2026-09-06T00:00:00.000Z";
const ACTIVATION_PUBLICATION_ID = "activation-publication";
const ACTIVATION_EVIDENCE_SHA256 = "a".repeat(64);

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "lcm-rollback-session-pg-"));
  mkdirSync(join(dir, ".lcm"), { mode: 0o700 });
  dirs.push(dir);
  return dir;
}

function storageWitness(backend: "sqlite" | "postgresql", seed: string): MigrationStorageWitness {
  return {
    version: 1, backend, identitySha256: seed.repeat(64).slice(0, 64), schemaSha256: "2".repeat(64),
    contentSha256: "3".repeat(64), capturedAt,
  };
}

/** A manifest at phase "verified", reached through the ordinary forward effect sequence. */
function manifestAtVerified(
  store: MigrationManifestStore,
  generationId: string,
  destinationIdentitySha256?: string,
): MigrationManifest {
  let m = store.create(createMigrationManifest({
    generationId, source: storageWitness("sqlite", "1"),
    destination: { ...storageWitness("postgresql", "4"), ...(destinationIdentitySha256 === undefined ? {} : { identitySha256: destinationIdentitySha256 }) },
    parentGenerationId: null, preservedSourceGenerationId: generationId, createdAt: capturedAt,
  }));
  const step = (kind: string, extra: Record<string, unknown> = {}) => {
    m = store.update(generationId, m.checksumSha256, (current) => beginMigrationEffect(current, {
      kind: kind as never, effectId: kind, inputSha256: "a".repeat(64), startedAt: capturedAt,
    }));
    m = store.update(generationId, m.checksumSha256, (current) => completeMigrationEffect(current, {
      effectId: kind, completedAt: capturedAt, ...extra,
    }));
  };
  step("verify-dry-run", { report: { kind: "dry-run", reportId: "r1", reportSha256: "b".repeat(64), createdAt: capturedAt } });
  step("copy-batch", { checkpoint: { domain: "conversations", ordinal: 1, recordCount: 1, sourceCheckpointSha256: "c".repeat(64), destinationCommitSha256: "d".repeat(64) } });
  step("complete-copy");
  step("verify-generation", {
    report: { kind: "verification", reportId: "r2", reportSha256: "b".repeat(64), createdAt: capturedAt },
    activationEligible: true,
  });
  return m;
}

function targetFor(database: PostgreSqlTestDatabase): RollbackSessionTarget {
  return {
    settings: settings(database.runtimeUrl),
    expectedOwner: "lcm_test_migrator",
    expectedIdentity: fixture.expectedIdentity,
    localProjectId: fixture.localProjectId,
    remoteProjectId: fixture.projectId,
    machineId: fixture.machineId,
  };
}

/** Everything real except the first-open local append-barrier quiescence check (recovery admission is real). */
const dependencies: RollbackSessionDependencies = {
  ...DEFAULT_ROLLBACK_SESSION_DEPENDENCIES,
  checkQuiescence: async () => ({
    status: "satisfied", reason: "quiescence-observed", detail: "stand-in",
    quiescenceFence: { version: 1, kind: "lcm-activation-writer-quiescence-v1", payload: "{}", evidenceSha256: "a".repeat(64) },
  }),
};

async function scan(database: PostgreSqlTestDatabase) {
  const snapshot = await database.runtime.openReadOnlySnapshot({ projectId: fixture.projectId });
  try {
    const read = await readFencedDestinationCensus(snapshot, {
      settings: settings(database.runtimeUrl), expectedOwner: "lcm_test_migrator",
      expectedIdentity: fixture.expectedIdentity, scratchParent: tmpdir(),
    });
    return { delta: buildMigrationCanonicalDelta(read.census), census: buildMigrationCensusVector(read.census) };
  } finally {
    await snapshot.close();
  }
}

async function insertConversation(database: PostgreSqlTestDatabase, sessionId: string): Promise<void> {
  await database.migrator.query({
    text: "INSERT INTO lcm.conversations (project_id, session_id, title, bootstrapped_at, created_at, updated_at) "
      + "VALUES ($1, $2, NULL, NULL, $3, $3)",
    values: [fixture.projectId, sessionId, fixture.laterTimestamp],
  }, factoryContext);
}

/** An in-place change: neither a record count nor a terminal identity moves, so only the census can see it. */
async function editFirstMessage(database: PostgreSqlTestDatabase, content: string): Promise<void> {
  await database.migrator.query({
    text: "UPDATE lcm.messages SET content = $2 WHERE ctid = "
      + "(SELECT ctid FROM lcm.messages WHERE project_id = $1 ORDER BY conversation_id, seq LIMIT 1)",
    values: [fixture.projectId, content],
  }, factoryContext);
}

type LeaseRow = Readonly<{
  operation: string; owner_machine_id: string; owner_process_id: string; fencing_token: string; released: boolean; live: boolean;
}>;

async function leaseRow(database: PostgreSqlTestDatabase): Promise<LeaseRow | undefined> {
  const result = await database.migrator.query<LeaseRow>({
    text: "SELECT operation, owner_machine_id::text AS owner_machine_id, owner_process_id, fencing_token::text AS fencing_token, "
      + "released_at IS NOT NULL AS released, expires_at > statement_timestamp() AS live FROM lcm.fenced_leases WHERE project_id = $1",
    values: [fixture.projectId],
  }, factoryContext);
  return result.rows[0];
}

type ProjectMapFile = Record<string, { canonical: string; aliases: string[]; remoteProjectId?: string }>;

function writeProjectMap(homeDir: string, map: ProjectMapFile): void {
  clearProjectMapCache();
  writeFileSync(projectMapPath(homeDir), JSON.stringify(map), { mode: 0o600 });
}

function readProjectMapFile(homeDir: string): ProjectMapFile {
  return JSON.parse(readFileSync(projectMapPath(homeDir), "utf8")) as ProjectMapFile;
}

function readConfigBackend(homeDir: string): string {
  return (JSON.parse(readFileSync(configPath(homeDir), "utf8")) as { storage: { backend: string } }).storage.backend;
}

/** The sqlite-selecting config an installation holds before activation; its postgresql block survives every publication. */
function writeSourceConfig(homeDir: string, backend: "sqlite" | "postgresql" = "sqlite", poolMax?: number): void {
  writeFileSync(configPath(homeDir), `${JSON.stringify({
    storage: { backend, postgresql: { migrationRole: "lcm_test_migrator", ...(poolMax === undefined ? {} : { poolMax }) } },
  })}\n`, { mode: 0o600 });
}

const unboundMap: ProjectMapFile = { [fixture.localProjectId]: { canonical: fixture.path, aliases: [] } };
const boundMap: ProjectMapFile = {
  [fixture.localProjectId]: { canonical: fixture.path, aliases: [], remoteProjectId: fixture.projectId },
};

/**
 * Activates the covered project exactly as the activation does: the real coordinator, over the production
 * driver and the PostgreSQL remote guard, publishes the postgresql config and the bound project map and
 * releases the fence. The activation's evidence and bindings are recorded in the real stores afterwards.
 */
async function activate(
  database: PostgreSqlTestDatabase,
  homeDir: string,
  generationId: string,
  options: { record?: boolean; poolMax?: number } = {},
): Promise<void> {
  writeSourceConfig(homeDir, "sqlite", options.poolMax);
  writeProjectMap(homeDir, unboundMap);
  const composed = composeBackendPublicationMaterial({
    homeDir, targetBackend: "postgresql",
    bindings: [{ localProjectId: fixture.localProjectId, remoteProjectId: fixture.projectId, evidenceSha256: ACTIVATION_EVIDENCE_SHA256 }],
  });
  const runtime = new PostgreSqlRuntime(settings(database.runtimeUrl));
  try {
    const coordinator = createBackendPublicationCoordinator({
      homeDir,
      remoteGuard: {
        mode: "delegated",
        provider: createPostgreSqlBackendPublicationRemoteGuard({
          guard: runtime.backendPublicationGuard(), machineId: fixture.machineId, ttlMs: 60_000,
        }),
      },
    });
    await coordinator.prepare({ publicationId: ACTIVATION_PUBLICATION_ID, ...composed });
    await coordinator.resume();
  } finally {
    await runtime.close();
  }
  // Without the records the publication is complete but the activation never recorded its epoch or binding.
  if (options.record === false) return;
  const baseline = await scan(database);
  const scenario = fixtureActivationScenario({
    generationId, publicationId: ACTIVATION_PUBLICATION_ID,
    destinationIdentity: await captureDestinationIdentity(database.runtime, fixture.projectId),
    censusVector: baseline.census, canonicalDeltaBaseline: baseline.delta,
  });
  recordMigrationActivationEpoch({ homeDir, epoch: scenario.epoch });
  recordMigrationActivationAttempt({ homeDir, generationId, attempt: scenario.attempt });
  recordMigrationActivationWitness({ homeDir, generationId, witness: scenario.witness });
  recordMigrationWitnessBinding({ homeDir, generationId, binding: scenario.witnessBinding });
  recordMigrationSelectionBinding({ homeDir, generationId, binding: scenario.selection });
}

/**
 * The seeded database, a verified manifest and, by default, a published activation. With activated false the
 * installation holds no activation evidence: by default its configuration selects PostgreSQL and its map binds
 * the project without any coordinator publication (a shape rollback refuses as never activated), "unpublished" leaves
 * the configuration on sqlite, and "recordless" is a complete coordinator publication whose epoch and binding
 * were never recorded.
 */
async function prepared(
  database: PostgreSqlTestDatabase,
  generationId: string,
  options: { activated?: boolean; shape?: "unpublished" | "recordless"; poolMax?: number } = {},
) {
  await applyAllRuntimeGrants(database);
  await seedPortablePostgreSql(database.migrator);
  const homeDir = tempHome();
  if (options.activated === false) {
    // With no activation epoch the only comparand is the manifest's own sealed destination witness, so the
    // manifest is sealed against the live destination, as a real copy records it.
    const destination = await captureDestinationIdentity(database.runtime, fixture.projectId);
    manifestAtVerified(new MigrationManifestStore({ homeDir }), generationId, destination.sealedWitnessSha256);
    if (options.shape === "recordless") {
      await activate(database, homeDir, generationId, { record: false });
    } else {
      writeSourceConfig(homeDir, options.shape === "unpublished" ? "sqlite" : "postgresql");
      writeProjectMap(homeDir, boundMap);
    }
  } else {
    manifestAtVerified(new MigrationManifestStore({ homeDir }), generationId);
    await activate(database, homeDir, generationId, { poolMax: options.poolMax });
  }
  return { homeDir, canonicalPath: join(homeDir, "live.sqlite") };
}

type Run = Readonly<{
  homeDir: string;
  generationId: string;
  canonicalPath: string;
  database: PostgreSqlTestDatabase;
  /** Wraps the opened session, for injecting a change at an exact point of the window. */
  wrap?: (session: Awaited<ReturnType<typeof openRollbackFencedSession>>) => void;
  /** Wraps the coordinator the entry builds (a crash right after one of its methods). */
  wrapCoordinator?: (coordinator: ReturnType<typeof createBackendPublicationCoordinator>) => void;
  /** Passed to the coordinator the entry builds. */
  observer?: Parameters<typeof createBackendPublicationCoordinator>[0]["observer"];
}>;

/** The entry's dependencies: the forward snapshot evidence and machine identity are supplied; everything else is real. */
function entryDependencies(run: Run): RollbackEntryDependencies {
  return {
    context: {
      ...DEFAULT_RESOLVE_ROLLBACK_CONTEXT_DEPENDENCIES,
      inspectSnapshot: (async () => ({
        artifact: {
          sourceSelectionSha256: "5".repeat(64), queueEvidenceSha256: "6".repeat(64), sourceByteWitnessSha256: "7".repeat(64),
          authority: {
            physicalProjectId: fixture.localProjectId, projectDbPath: run.canonicalPath,
            machineIdentity: { identityKey: fixture.machineIdentityKey, machineId: fixture.machineId },
          },
        },
        receiptReference: { queueCutoff: null },
      })) as never,
      requireMachineIdentity: (() => ({ machineId: fixture.machineId })) as never,
      resolveIdentity: (() => fixture.expectedIdentity) as never,
    },
    session: dependencies,
    createCoordinator: (options) => {
      const coordinator = createBackendPublicationCoordinator({ ...options, observer: run.observer });
      run.wrapCoordinator?.(coordinator);
      return coordinator;
    },
    run: (input, deps) => runMigrationRollback(input, {
      ...deps,
      openFencedSession: async (request) => {
        const session = await deps.openFencedSession(request);
        run.wrap?.(session);
        return session;
      },
    }),
  };
}

/** The connection secrets never live in config.json: the entry reads them from the environment, as the daemon does. */
async function runRollback(run: Run) {
  const previous = { url: process.env.LCM_POSTGRES_URL, caFile: process.env.LCM_POSTGRES_CA_FILE };
  const connection = settings(run.database.runtimeUrl);
  process.env.LCM_POSTGRES_URL = connection.url;
  process.env.LCM_POSTGRES_CA_FILE = connection.caFile;
  try {
    return await runMigrationRollbackFromHome({ homeDir: run.homeDir, generationId: run.generationId }, entryDependencies(run));
  } finally {
    if (previous.url === undefined) delete process.env.LCM_POSTGRES_URL; else process.env.LCM_POSTGRES_URL = previous.url;
    if (previous.caFile === undefined) delete process.env.LCM_POSTGRES_CA_FILE; else process.env.LCM_POSTGRES_CA_FILE = previous.caFile;
  }
}

function rollbackBinding(homeDir: string, generationId: string) {
  const resolved = resolveMigrationWitnessBindings({ homeDir, generationId });
  return resolved.state === "resolved" ? resolved.selections.find((selection) => selection.kind === "rollback") : undefined;
}

/** The rollback's publication in the live slot, completed: the sqlite config and the unbound project map are published. */
function expectRollbackPublished(homeDir: string, generationId: string): void {
  expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
  expect(readBackendPublicationJournal(homeDir)).toMatchObject({
    phase: "completed", publicationId: deriveRollbackPublicationId(generationId),
    sourceBackend: "postgresql", targetBackend: "sqlite",
  });
  expect(readConfigBackend(homeDir)).toBe("sqlite");
  expect(readProjectMapFile(homeDir)[fixture.localProjectId]!.remoteProjectId).toBeUndefined();
}

function failCompleteSelection(coordinator: ReturnType<typeof createBackendPublicationCoordinator>): void {
  coordinator.completeMaintenanceSelection = async () => {
    throw new Error("simulated I/O failure in completeMaintenanceSelection");
  };
}

function crashAfter(method: "prepare" | "resume" | "completeMaintenanceSelection") {
  return (coordinator: ReturnType<typeof createBackendPublicationCoordinator>): void => {
    const target = coordinator as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const real = target[method]!.bind(coordinator);
    target[method] = async (...args: unknown[]) => {
      await real(...args);
      throw new Error("simulated crash right after " + method);
    };
  };
}

describe("production rollback against PostgreSQL 18", { timeout: 240_000 }, () => {
  it("holds a real lease for the coordinator's identity, renews and asserts it, refuses once the fence is lost, and releases", async () => {
    await withPostgreSqlTestDatabase("rollback-session-lease", async (database) => {
      await applyAllRuntimeGrants(database);
      await seedPortablePostgreSql(database.migrator);
      const homeDir = tempHome();
      const manifest = manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-lease");
      const session = await openRollbackFencedSession(
        { homeDir, manifest, lockToken: {} as never }, targetFor(database), dependencies,
      );
      const held = await leaseRow(database);
      expect(held).toMatchObject({ released: false, live: true, owner_machine_id: fixture.machineId });
      expect(held!.operation).toMatch(/^backend-publication:sqlite:[0-9a-f]{64}$/u);
      // The selection authority describes the real fence, field for field.
      const row = (await database.migrator.query<{
        resource_type: string; resource_key: string; fencing_token: string; owner_process_id: string;
      }>({
        text: "SELECT resource_type, resource_key, fencing_token::text AS fencing_token, owner_process_id "
          + "FROM lcm.fenced_leases WHERE project_id = $1",
        values: [fixture.projectId],
      }, factoryContext)).rows[0]!;
      expect(session.selectionAuthority).toEqual({
        version: 1,
        resourceType: row.resource_type,
        resourceKey: row.resource_key,
        fencingToken: row.fencing_token,
        ownerProcessId: row.owner_process_id,
      });
      expect(row.owner_process_id).toBe(deriveRollbackPublicationId("gen-lease"));

      await session.renew();

      // The fence is lost underneath the open window: the next renew refuses, it never re-acquires.
      await database.migrator.query({
        text: "UPDATE lcm.fenced_leases SET released_at = statement_timestamp() WHERE project_id = $1",
        values: [fixture.projectId],
      }, factoryContext);
      await expect(session.renew()).rejects.toBeInstanceOf(RollbackSessionError);
      await session.release();
    });
  });

  it("releases the lease on release(), and a second session for the same rollback may then acquire it", async () => {
    await withPostgreSqlTestDatabase("rollback-session-release", async (database) => {
      await applyAllRuntimeGrants(database);
      await seedPortablePostgreSql(database.migrator);
      const homeDir = tempHome();
      const manifest = manifestAtVerified(new MigrationManifestStore({ homeDir }), "gen-release");
      const open = () => openRollbackFencedSession({ homeDir, manifest, lockToken: {} as never }, targetFor(database), dependencies);
      const first = await open();
      // Same rollback, lease still live: acquiring again is the idempotent re-acquire of a crashed attempt.
      const second = await open();
      expect(second.selectionAuthority.fencingToken).toBe(first.selectionAuthority.fencingToken);
      await first.release();
      expect((await leaseRow(database))!.released).toBe(true);
      await second.release();
    });
  });

  it("rolls back pre-write on an unchanged destination: no data moves, sqlite is published and replay admission routes to it", async () => {
    await withPostgreSqlTestDatabase("rollback-session-pre-write", async (database) => {
      const { homeDir, canonicalPath } = await prepared(database, "gen-pre");
      // The activation's lease row is released; the rollback replaces it.
      expect(await leaseRow(database)).toMatchObject({ released: true, operation: expect.stringMatching(/^backend-publication:postgresql:/u) });
      expect(readConfigBackend(homeDir)).toBe("postgresql");

      const outcome = await runRollback({ homeDir, generationId: "gen-pre", canonicalPath, database });

      expect(outcome.manifest.phase).toBe("rolled-back");
      expect(outcome.manifest.rollbackLineage.mode).toBe("pre-write");
      expect(existsSync(canonicalPath)).toBe(false);
      expectRollbackPublished(homeDir, "gen-pre");
      expect(outcome.report!.sealedPublicationMaterialDigestSha256)
        .toBe(readBackendPublicationJournal(homeDir)!.recoveryReference!.sealSha256);
      // The coordinator released the fence it adopted from the session, exactly once.
      expect(await leaseRow(database)).toMatchObject({
        released: true, operation: expect.stringMatching(/^backend-publication:sqlite:/u),
        owner_process_id: deriveRollbackPublicationId("gen-pre"),
      });
      // The coordinator's prepare archived the maintenance journal: admission routes from the binding, with fresh state.
      clearProjectMapCache();
      expect(assertMigrationReplayAdmission({
        homeDir, generationId: "gen-pre", evidenceSha256: rollbackBinding(homeDir, "gen-pre")!.witnessChecksumSha256,
      })).toEqual({ backend: "sqlite", disposition: "selected" });
    });
  });

  it("refuses a generation whose configuration was never published, naming abort as the way out", async () => {
    await withPostgreSqlTestDatabase("rollback-session-config-unpublished", async (database) => {
      const { homeDir, canonicalPath } = await prepared(database, "gen-unpublished", { activated: false, shape: "unpublished" });
      await expect(runRollback({ homeDir, generationId: "gen-unpublished", canonicalPath, database }))
        .rejects.toMatchObject({ reason: "input-unresolvable", message: expect.stringContaining("lcm migration abort") });
      expect(readConfigBackend(homeDir)).toBe("sqlite");
      expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
    });
  });

  it("refuses a never-activated generation (configuration selects PostgreSQL, no activation evidence) before any lease, maintenance or manifest change", async () => {
    await withPostgreSqlTestDatabase("rollback-session-unactivated", async (database) => {
      const { homeDir, canonicalPath } = await prepared(database, "gen-unactivated", { activated: false });
      await expect(runRollback({ homeDir, generationId: "gen-unactivated", canonicalPath, database }))
        .rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("never completed an activation") });
      // Nothing was written: the configuration still selects PostgreSQL, no maintenance, lease or effect exists.
      expect(readConfigBackend(homeDir)).toBe("postgresql");
      expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
      expect(await leaseRow(database)).toBeUndefined();
      const manifest = new MigrationManifestStore({ homeDir }).read("gen-unactivated");
      expect(manifest.phase).toBe("verified");
      expect(manifest.pendingEffect).toBeNull();
    });
  });

  it("refuses a complete publication whose activation never recorded its binding (published-but-unbound)", async () => {
    await withPostgreSqlTestDatabase("rollback-session-recordless", async (database) => {
      const { homeDir, canonicalPath } = await prepared(database, "gen-recordless", { activated: false, shape: "recordless" });
      await expect(runRollback({ homeDir, generationId: "gen-recordless", canonicalPath, database }))
        .rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("published-but-unbound") });
      expect(readConfigBackend(homeDir)).toBe("postgresql");
    });
  });

  it("refuses while the activation's lease row is still held, leaving PostgreSQL selected", async () => {
    await withPostgreSqlTestDatabase("rollback-session-held-activation", async (database) => {
      const { homeDir, canonicalPath } = await prepared(database, "gen-held");
      await database.migrator.query({
        text: "UPDATE lcm.fenced_leases SET released_at = NULL, expires_at = statement_timestamp() + interval '1 hour' WHERE project_id = $1",
        values: [fixture.projectId],
      }, factoryContext);
      await expect(runRollback({ homeDir, generationId: "gen-held", canonicalPath, database }))
        .rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("actively held by a different publication generation") });
      expect(readConfigBackend(homeDir)).toBe("postgresql");
      expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-held");
    });
  });

  it("refuses a second remotely bound project before any lease, maintenance or manifest change (A14)", async () => {
    await withPostgreSqlTestDatabase("rollback-session-two-projects", async (database) => {
      const { homeDir, canonicalPath } = await prepared(database, "gen-two-projects");
      writeProjectMap(homeDir, {
        ...boundMap,
        ["f".repeat(64)]: { canonical: "/another", aliases: [], remoteProjectId: "01990000-0000-7000-8000-0000000000ff" },
      });
      const leaseBefore = await leaseRow(database);
      await expect(runRollback({ homeDir, generationId: "gen-two-projects", canonicalPath, database }))
        .rejects.toMatchObject({ reason: "not-eligible", message: expect.stringContaining("multiple-remote-projects") });
      expect(await leaseRow(database)).toEqual(leaseBefore);
      expect(readBackendMaintenanceJournal(homeDir)).toBeNull();
      expect(readConfigBackend(homeDir)).toBe("postgresql");
      expect(new MigrationManifestStore({ homeDir }).read("gen-two-projects").phase).toBe("verified");
    });
  });

  it("rolls back post-write after a racing post-epoch write, exporting the written data into the installed database", async () => {
    await withPostgreSqlTestDatabase("rollback-session-post-write", async (database) => {
      const { homeDir, canonicalPath } = await prepared(database, "gen-post");
      await insertConversation(database, "raced-session");
      const outcome = await runRollback({ homeDir, generationId: "gen-post", canonicalPath, database });
      expect(outcome.manifest.rollbackLineage.mode).toBe("post-write");
      expectRollbackPublished(homeDir, "gen-post");
      const installed = new DatabaseSync(canonicalPath, { readOnly: true });
      try {
        const row = installed.prepare("SELECT count(*) AS n FROM conversations WHERE session_id = ?").get("raced-session") as { n: number };
        expect(row.n).toBe(1);
        // Both machines hold a session instruction under one scope hash; the machine-local cache keeps this machine's only.
        const cache = installed.prepare("SELECT content FROM session_instruction_cache WHERE project_id = ?").all(fixture.localProjectId);
        expect(cache).toEqual([{ content: "Primary instruction" }]);
      } finally {
        installed.close();
      }
      expect((await leaseRow(database))!.released).toBe(true);
    });
  });

  it("#1694: a post-write rollback completes with rows a real replication pass uploaded resident in the inbox", async () => {
    await withPostgreSqlTestDatabase("rollback-session-replicated-inbox", async (database) => {
      const { homeDir, canonicalPath } = await prepared(database, "gen-replicated");
      // The local machine's own outbox, at the path the rollback reconciles; the worker leaves its rows
      // quarantined (inbox and local), retry and pending (inbox) with a replicated local row, never acknowledged.
      const outboxPath = join(eventsDir(homeDir), `${fixture.localProjectId}.db`);
      const replicated = await replicateIntoInbox(database, homeDir, {
        projectId: fixture.projectId, machineId: fixture.machineId, outboxPath,
      });
      await replicated.close();
      await insertConversation(database, "raced-session-replicated");
      const states = async () => (await database.migrator.query<{ data: string; status: string }>({
        text: "SELECT payload->>'data' AS data, status FROM lcm.passive_event_inbox WHERE payload->>'data' LIKE 'replicated-%' ORDER BY machine_sequence",
      }, factoryContext)).rows;
      const before = [
        { data: "replicated-0", status: "quarantined" }, { data: "replicated-1", status: "retry" },
        { data: "replicated-2", status: "pending" },
      ];
      expect(await states()).toEqual(before);
      const prevEventIds = new Map(replicated.events.map((event) => [event.data, event.prevEventId]));
      expect(readOutboxPrevEventIds(outboxPath)).toEqual(prevEventIds);

      const outcome = await runRollback({ homeDir, generationId: "gen-replicated", canonicalPath, database });
      expect(outcome.manifest.rollbackLineage.mode).toBe("post-write");
      expectRollbackPublished(homeDir, "gen-replicated");
      expect((await leaseRow(database))!.released).toBe(true);
      // The upload stays resident, and the resident local rows keep their previous-event pointers.
      expect(await states()).toEqual(before);
      // The rollback also materializes the fixture's own archived rows next to them.
      const after = [...readOutboxPrevEventIds(outboxPath)].filter(([data]) => data.startsWith("replicated-"));
      expect(new Map(after)).toEqual(prevEventIds);
    });
  });

  it("F4: a post-write rollback completes with poolMax=1, because the export snapshot is closed with its stream", async () => {
    await withPostgreSqlTestDatabase("rollback-session-pool-one", async (database) => {
      const { homeDir, canonicalPath } = await prepared(database, "gen-pool-one", { poolMax: 1 });
      expect(JSON.parse(readFileSync(configPath(homeDir), "utf8")).storage.postgresql.poolMax).toBe(1);
      await insertConversation(database, "raced-session-pool-one");
      const outcome = await runRollback({ homeDir, generationId: "gen-pool-one", canonicalPath, database });
      expect(outcome.manifest.rollbackLineage.mode).toBe("post-write");
      expectRollbackPublished(homeDir, "gen-pool-one");
      expect((await leaseRow(database))!.released).toBe(true);
    });
  });

  it("classifies an in-place post-epoch change as post-write although the delta is unchanged, because the census sees it", async () => {
    await withPostgreSqlTestDatabase("rollback-session-in-place", async (database) => {
      const { homeDir, canonicalPath } = await prepared(database, "gen-inplace");
      await editFirstMessage(database, "Edited after activation");
      const outcome = await runRollback({ homeDir, generationId: "gen-inplace", canonicalPath, database });
      expect(outcome.manifest.rollbackLineage.mode).toBe("post-write");
    });
  });

  it("resumes through the coordinator after a crash right after its prepare, from a fresh process", async () => {
    await withPostgreSqlTestDatabase("rollback-session-crash-prepare", async (database) => {
      const { homeDir, canonicalPath } = await prepared(database, "gen-crash-prepare");
      await expect(runRollback({
        homeDir, generationId: "gen-crash-prepare", canonicalPath, database, wrapCoordinator: crashAfter("prepare"),
      })).rejects.toMatchObject({ reason: "unexpected-state", message: expect.stringContaining("simulated crash right after prepare") });
      expect(readBackendPublicationJournal(homeDir)).toMatchObject({ phase: "prepared" });
      expect(readConfigBackend(homeDir)).toBe("postgresql");
      expect(rollbackBinding(homeDir, "gen-crash-prepare")).toBeDefined();

      const outcome = await runRollback({ homeDir, generationId: "gen-crash-prepare", canonicalPath, database });

      expect(outcome.manifest.phase).toBe("rolled-back");
      expectRollbackPublished(homeDir, "gen-crash-prepare");
      expect((await leaseRow(database))!.released).toBe(true);
    });
  });

  it("F1: a failure after the selection was prepared keeps the lease, so guarded writers stay fenced out; a write that got past the fence refuses the retry", async () => {
    await withPostgreSqlTestDatabase("rollback-session-f1-drift", async (database) => {
      const { homeDir, canonicalPath } = await prepared(database, "gen-f1-drift");
      await expect(runRollback({
        homeDir, generationId: "gen-f1-drift", canonicalPath, database, wrapCoordinator: failCompleteSelection,
      })).rejects.toMatchObject({ message: expect.stringContaining("simulated I/O failure in completeMaintenanceSelection") });
      expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("selection-prepared");
      // The lease is still held (not released), so the production mutation guard refuses a writer.
      expect(await leaseRow(database)).toMatchObject({ released: false, live: true, owner_process_id: deriveRollbackPublicationId("gen-f1-drift") });
      await expect(acquirePostgreSqlProjectMutationGuard(database.migrator, fixture.projectId, factoryContext))
        .rejects.toThrow();

      // A write that bypassed the guard (out of band) lands before the retry.
      await insertConversation(database, "written-after-failure");
      await expect(runRollback({ homeDir, generationId: "gen-f1-drift", canonicalPath, database }))
        .rejects.toMatchObject({ reason: "drift" });

      expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("selection-prepared");
      expect(readConfigBackend(homeDir)).toBe("postgresql");
      expect(new MigrationManifestStore({ homeDir }).read("gen-f1-drift").pendingEffect?.kind).toBe("publish-rollback");
      expect(await leaseRow(database)).toMatchObject({ released: false });
      const kept = await database.migrator.query<{ n: string }>({
        text: "SELECT count(*)::text AS n FROM lcm.conversations WHERE project_id = $1 AND session_id = 'written-after-failure'",
        values: [fixture.projectId],
      }, factoryContext);
      expect(kept.rows[0]!.n).toBe("1");
    });
  });

  it("F1: the same failure with no intervening write completes on retry under a fresh session and releases the lease", async () => {
    await withPostgreSqlTestDatabase("rollback-session-f1-clean", async (database) => {
      const { homeDir, canonicalPath } = await prepared(database, "gen-f1-clean");
      await expect(runRollback({
        homeDir, generationId: "gen-f1-clean", canonicalPath, database, wrapCoordinator: failCompleteSelection,
      })).rejects.toThrow("simulated I/O failure in completeMaintenanceSelection");
      expect(await leaseRow(database)).toMatchObject({ released: false });

      const outcome = await runRollback({ homeDir, generationId: "gen-f1-clean", canonicalPath, database });

      expect(outcome.manifest.phase).toBe("rolled-back");
      expectRollbackPublished(homeDir, "gen-f1-clean");
      expect((await leaseRow(database))!.released).toBe(true);
    });
  });

  it("F11: a completed selection that crashed before its binding is finished under a recovery open, and guarded writers stay fenced out meanwhile", async () => {
    await withPostgreSqlTestDatabase("rollback-session-f11-completed", async (database) => {
      const { homeDir, canonicalPath } = await prepared(database, "gen-f11-completed");
      await expect(runRollback({
        homeDir, generationId: "gen-f11-completed", canonicalPath, database, wrapCoordinator: crashAfter("completeMaintenanceSelection"),
      })).rejects.toMatchObject({ message: expect.stringContaining("simulated crash right after completeMaintenanceSelection") });
      expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("selection-completed");
      // The guard that makes a completed selection final: while the unreleased lease row exists, every
      // guarded PostgreSQL mutation refuses (publication-guard.ts acquirePostgreSqlProjectMutationGuard).
      expect(await leaseRow(database)).toMatchObject({ released: false, live: true });
      await expect(acquirePostgreSqlProjectMutationGuard(database.migrator, fixture.projectId, factoryContext))
        .rejects.toMatchObject({ reason: "publication-unresolved" });

      const outcome = await runRollback({ homeDir, generationId: "gen-f11-completed", canonicalPath, database });

      expect(outcome.manifest.phase).toBe("rolled-back");
      expectRollbackPublished(homeDir, "gen-f11-completed");
      expect((await leaseRow(database))!.released).toBe(true);
    });
  });

  it("resumes through the coordinator after a crash right after the config publish", async () => {
    await withPostgreSqlTestDatabase("rollback-session-crash-config", async (database) => {
      const { homeDir, canonicalPath } = await prepared(database, "gen-crash-config");
      await expect(runRollback({
        homeDir, generationId: "gen-crash-config", canonicalPath, database,
        observer: (event) => {
          if (event === "after-journal-write" && readBackendPublicationJournal(homeDir)?.phase === "config-published") {
            throw new Error("simulated crash right after the config publish");
          }
        },
      })).rejects.toMatchObject({ message: expect.stringContaining("simulated crash right after the config publish") });
      expect(readConfigBackend(homeDir)).toBe("sqlite");
      expect(readBackendPublicationJournal(homeDir)).toMatchObject({ phase: "config-published" });

      const outcome = await runRollback({ homeDir, generationId: "gen-crash-config", canonicalPath, database });

      expect(outcome.manifest.phase).toBe("rolled-back");
      expectRollbackPublished(homeDir, "gen-crash-config");
      expect((await leaseRow(database))!.released).toBe(true);
    });
  });

  it("E1: resumes a publication crashed at released without acquiring another lease; the one released row stays the only row", async () => {
    await withPostgreSqlTestDatabase("rollback-session-crash-released", async (database) => {
      const { homeDir, canonicalPath } = await prepared(database, "gen-crash-released");
      await expect(runRollback({
        homeDir, generationId: "gen-crash-released", canonicalPath, database,
        observer: (event) => {
          if (event === "after-journal-write" && readBackendPublicationJournal(homeDir)?.phase === "released") {
            throw new Error("simulated crash right after the fence release was journalled");
          }
        },
      })).rejects.toMatchObject({ message: expect.stringContaining("simulated crash right after the fence release was journalled") });
      expect(readBackendPublicationJournal(homeDir)).toMatchObject({ phase: "released" });
      expect(new MigrationManifestStore({ homeDir }).read("gen-crash-released").pendingEffect?.kind).toBe("publish-rollback");
      // The coordinator released the real fence before the crash: the row is released and no longer bars guarded writers.
      const releasedRow = (await leaseRow(database))!;
      expect(releasedRow).toMatchObject({ released: true, owner_process_id: deriveRollbackPublicationId("gen-crash-released") });
      await acquirePostgreSqlProjectMutationGuard(database.migrator, fixture.projectId, factoryContext);

      const outcome = await runRollback({ homeDir, generationId: "gen-crash-released", canonicalPath, database });

      expect(outcome.manifest.phase).toBe("rolled-back");
      expectRollbackPublished(homeDir, "gen-crash-released");
      // The retry acquired nothing: the released row keeps its fencing token, and guarded writers still pass.
      const rows = await database.migrator.query<{ n: string }>({
        text: "SELECT count(*)::text AS n FROM lcm.fenced_leases WHERE project_id = $1",
        values: [fixture.projectId],
      }, factoryContext);
      expect(rows.rows[0]!.n).toBe("1");
      expect(await leaseRow(database)).toMatchObject({ released: true, fencing_token: releasedRow.fencing_token });
      await acquirePostgreSqlProjectMutationGuard(database.migrator, fixture.projectId, factoryContext);
    });
  });

  it.each(["before-material-seal", "after-material-seal"] as const)("E6: finishes a publication crashed at %s (journal preparing, no recovery reference) under the original lease", async (crashAt) => {
    const generationId = "gen-crash-" + crashAt;
    await withPostgreSqlTestDatabase("rollback-session-crash-" + crashAt, async (database) => {
      const { homeDir, canonicalPath } = await prepared(database, generationId);
      await expect(runRollback({
        homeDir, generationId, canonicalPath, database,
        observer: (event) => { if (event === crashAt) throw new Error("simulated crash at " + crashAt); },
      })).rejects.toMatchObject({ message: expect.stringContaining("simulated crash at " + crashAt) });
      expect(readBackendPublicationJournal(homeDir)).toMatchObject({ phase: "preparing", recoveryReference: null });
      expect(readConfigBackend(homeDir)).toBe("postgresql");
      const held = (await leaseRow(database))!;
      expect(held).toMatchObject({ released: false, live: true, owner_process_id: deriveRollbackPublicationId(generationId) });

      const outcome = await runRollback({ homeDir, generationId, canonicalPath, database });

      expect(outcome.manifest.phase).toBe("rolled-back");
      expectRollbackPublished(homeDir, generationId);
      const rows = await database.migrator.query<{ n: string }>({
        text: "SELECT count(*)::text AS n FROM lcm.fenced_leases WHERE project_id = $1",
        values: [fixture.projectId],
      }, factoryContext);
      expect(rows.rows[0]!.n).toBe("1");
      expect(await leaseRow(database)).toMatchObject({ released: true, fencing_token: held.fencing_token });
      expect(assertMigrationReplayAdmission({
        homeDir, generationId, evidenceSha256: rollbackBinding(homeDir, generationId)!.witnessChecksumSha256,
      })).toEqual({ backend: "sqlite", disposition: "selected" });
    });
  });

  it("E7: a fresh run starting from the aborted unsealed journal (crash between the missing-material abort and the second prepare) prepares again under the original lease", async () => {
    const generationId = "gen-crash-aborted-unsealed";
    await withPostgreSqlTestDatabase("rollback-session-crash-aborted-unsealed", async (database) => {
      const { homeDir, canonicalPath } = await prepared(database, generationId);
      await expect(runRollback({
        homeDir, generationId, canonicalPath, database,
        observer: (event) => { if (event === "before-material-seal") throw new Error("simulated crash before the material seal"); },
      })).rejects.toMatchObject({ message: expect.stringContaining("simulated crash before the material seal") });
      await expect(runRollback({
        homeDir, generationId, canonicalPath, database,
        observer: (event) => {
          if (event === "after-journal-write" && readBackendPublicationJournal(homeDir)?.phase === "aborted") {
            throw new Error("simulated crash right after the missing-material abort");
          }
        },
      })).rejects.toMatchObject({ message: expect.stringContaining("simulated crash right after the missing-material abort") });
      expect(readBackendPublicationJournal(homeDir)).toMatchObject({ phase: "aborted", recoveryReference: null });
      expect(readConfigBackend(homeDir)).toBe("postgresql");
      const held = (await leaseRow(database))!;
      expect(held).toMatchObject({ released: false, live: true });

      const outcome = await runRollback({ homeDir, generationId, canonicalPath, database });

      expect(outcome.manifest.phase).toBe("rolled-back");
      expectRollbackPublished(homeDir, generationId);
      const rows = await database.migrator.query<{ n: string }>({
        text: "SELECT count(*)::text AS n FROM lcm.fenced_leases WHERE project_id = $1",
        values: [fixture.projectId],
      }, factoryContext);
      expect(rows.rows[0]!.n).toBe("1");
      expect(await leaseRow(database)).toMatchObject({ released: true, fencing_token: held.fencing_token });
    });
  });

  it("refuses when the fence is lost mid-window, installing and selecting nothing", async () => {
    await withPostgreSqlTestDatabase("rollback-session-fence-loss", async (database) => {
      const { homeDir, canonicalPath } = await prepared(database, "gen-fence");
      await insertConversation(database, "raced-session");
      await expect(runRollback({
        homeDir, generationId: "gen-fence", canonicalPath, database,
        wrap: (session) => {
          const renew = session.renew.bind(session);
          session.renew = async () => {
            await database.migrator.query({
              text: "UPDATE lcm.fenced_leases SET released_at = statement_timestamp() WHERE project_id = $1",
              values: [fixture.projectId],
            }, factoryContext);
            await renew();
          };
        },
      })).rejects.toMatchObject({ name: "MigrationRollbackError", reason: "lease-lost" });
      expect(existsSync(canonicalPath)).toBe(false);
      expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-held");
    });
  });

  it("A17: refuses an in-place update after the export snapshot that preserves every count and identity, leaving PostgreSQL authoritative", async () => {
    await withPostgreSqlTestDatabase("rollback-session-a17", async (database) => {
      const { homeDir, canonicalPath } = await prepared(database, "gen-a17");
      // Post-write by an in-place edit before the export; the delta carries no content.
      await editFirstMessage(database, "Edited after activation");
      const counts = async () => (await database.migrator.query<{ conversations: string; messages: string; ids: string }>({
        text: "SELECT (SELECT count(*) FROM lcm.conversations WHERE project_id = $1)::text AS conversations, "
          + "(SELECT count(*) FROM lcm.messages WHERE project_id = $1)::text AS messages, "
          + "(SELECT string_agg(conversation_id::text || ':' || seq::text, ',' ORDER BY conversation_id, seq) "
          + "FROM lcm.messages WHERE project_id = $1) AS ids",
        values: [fixture.projectId],
      }, factoryContext)).rows[0]!;
      const beforeUpdate = await counts();
      await expect(runRollback({
        homeDir, generationId: "gen-a17", canonicalPath, database,
        wrap: (session) => {
          const renew = session.renew.bind(session);
          // renew() is the first thing step 10 does, after the export snapshot was built from.
          session.renew = async () => {
            await editFirstMessage(database, "Changed once more after the export snapshot");
            expect(await counts()).toEqual(beforeUpdate);
            await renew();
          };
        },
      })).rejects.toMatchObject({ reason: "drift", message: expect.stringContaining("census differs") });

      expect(existsSync(canonicalPath)).toBe(false);
      const journal = readBackendMaintenanceJournal(homeDir);
      expect(journal?.phase).toBe("maintenance-held");
      expect(journal?.targetBackend ?? null).toBeNull();
      expect(rollbackBinding(homeDir, "gen-a17")).toBeUndefined();
      expect(readConfigBackend(homeDir)).toBe("postgresql");
      const manifest = new MigrationManifestStore({ homeDir }).read("gen-a17");
      expect(manifest.phase).toBe("rolling-back");
      expect(manifest.pendingEffect).toBeNull();
      expect((await leaseRow(database))!.released).toBe(true);
    });
  });

  it("A6: refuses an unfenced change between build and revalidation that leaves the mode at post-write, installing and selecting nothing", async () => {
    await withPostgreSqlTestDatabase("rollback-session-a6", async (database) => {
      const { homeDir, canonicalPath } = await prepared(database, "gen-a6");
      await insertConversation(database, "raced-session");
      await expect(runRollback({
        homeDir, generationId: "gen-a6", canonicalPath, database,
        wrap: (session) => {
          const renew = session.renew.bind(session);
          // renew() is the first thing step 10 does, after the export snapshot was built from.
          session.renew = async () => {
            await editFirstMessage(database, "Changed after the export snapshot");
            await renew();
          };
        },
      })).rejects.toMatchObject({ reason: "drift", message: expect.stringContaining("census differs") });
      expect(existsSync(canonicalPath)).toBe(false);
      expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-held");
    });
  });

  it("#1698: a post-write rollback completes after a real replication pass delivered, acknowledged and pruned the local rows", async () => {
    await withPostgreSqlTestDatabase("rollback-session-drained-pruned", async (database) => {
      const { homeDir, canonicalPath } = await prepared(database, "gen-drained");
      const outboxPath = join(eventsDir(homeDir), `${fixture.localProjectId}.db`);
      const drained = await drainIntoPrunedState(database, {
        projectId: fixture.projectId, machineId: fixture.machineId, outboxPath,
      });
      await insertConversation(database, "raced-session-drained");
      // The steady state after a drain: no inbox row left in PostgreSQL, every local row acknowledged and pruned.
      const inboxRows = async () => (await database.migrator.query<{ n: string }>({
        text: "SELECT count(*)::text AS n FROM lcm.passive_event_inbox WHERE payload->>'data' LIKE 'drained-%'",
      }, factoryContext)).rows[0]!.n;
      expect(await inboxRows()).toBe("0");
      const before = readDeliveryRows(outboxPath);
      expect(before.map((row) => row.data)).toEqual(drained.data);
      expect(before.every((row) => row.delivery_state === "acknowledged" && row.remote_inbox_id !== null && row.remote_pruned_at !== null)).toBe(true);

      const outcome = await runRollback({ homeDir, generationId: "gen-drained", canonicalPath, database });
      expect(outcome.manifest.rollbackLineage.mode).toBe("post-write");
      expectRollbackPublished(homeDir, "gen-drained");
      expect((await leaseRow(database))!.released).toBe(true);
      // The local rows keep their delivery state, inbox id, prune marker and (unset) processing marker: the daemon's
      // remote apply does nothing, so the SQLite consumer still promotes them.
      expect(before.every((row) => row.processed_at === null)).toBe(true);
      expect(readDeliveryRows(outboxPath)).toEqual(before);
    });
  });

  it("#1698: a post-write rollback still refuses before publishing when a delivered row's prune was never recorded locally", async () => {
    await withPostgreSqlTestDatabase("rollback-session-drained-unpruned", async (database) => {
      const { homeDir, canonicalPath } = await prepared(database, "gen-unpruned");
      const outboxPath = join(eventsDir(homeDir), `${fixture.localProjectId}.db`);
      const drained = await drainIntoPrunedState(database, {
        projectId: fixture.projectId, machineId: fixture.machineId, outboxPath,
      });
      forgetLocalPrune(outboxPath, drained.data[1]!);
      await insertConversation(database, "raced-session-unpruned");
      const before = readDeliveryRows(outboxPath);
      await expect(runRollback({ homeDir, generationId: "gen-unpruned", canonicalPath, database }))
        .rejects.toMatchObject({ name: "MigrationRollbackError", reason: "unexpected-state" });
      // Nothing was published or installed; the manifest is still resumable and PostgreSQL stays authoritative.
      expect(existsSync(canonicalPath)).toBe(false);
      expect(readBackendMaintenanceJournal(homeDir)?.phase).toBe("maintenance-held");
      expect(rollbackBinding(homeDir, "gen-unpruned")).toBeUndefined();
      expect(readConfigBackend(homeDir)).toBe("postgresql");
      const manifest = new MigrationManifestStore({ homeDir }).read("gen-unpruned");
      expect(manifest.phase).toBe("rolling-back");
      expect(manifest.pendingEffect).toBeNull();
      expect(readDeliveryRows(outboxPath)).toEqual(before);
    });
  });
});
