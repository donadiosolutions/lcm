import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { settings, type PostgreSqlTestDatabase } from "./harness.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import type { PostgreSqlConnectionSettings } from "../../src/storage/postgresql/contracts.js";
import { PostgreSqlIdentityRepository } from "../../src/storage/postgresql/identity-repository.js";
import { BackendPublicationCoordinator, readBackendMaintenanceJournal, withBackendPublicationAppendBarrierAsync, type BackendPublicationDriver } from "../../src/storage/backend-publication.js";
import type { StorageIdentityContext } from "../../src/storage/contracts.js";
import { closeLcmConnection } from "../../src/db/connection.js";
import { localProjectIdentity } from "../../src/daemon/project.js";
import { appendLocalHookEvents } from "../../src/hooks/local-enqueue.js";
import { readMachineIdentity } from "../../src/machine-identity.js";
import { clearProjectMapCache, projectMapPath } from "../../src/project-map.js";
import { configPath, projectsDir } from "../../src/runtime-paths.js";
import { type MigrationActivationInput } from "../../src/migration/activate-generation.js";
import { deriveActivationPublicationId } from "../../src/migration/activation-publication-id.js";
import { inspectSqliteMigrationCopy, runSqliteMigrationCopy } from "../../src/migration/batch-copy.js";
import { migrationCopyTargetGeneration } from "../../src/migration/copy-source.js";
import { authenticateSqliteMigrationSource, authenticateSqliteMigrationSourceBytes, captureAuthenticatedSqliteMigrationSource, prepareSqliteMigrationEnrollment } from "../../src/migration/maintenance.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { computeMigrationProjectMapWitnessSha256 } from "../../src/migration/project-map-witness.js";
import { beginMigrationEffect, completeMigrationEffect, createMigrationManifest } from "../../src/migration/protocol.js";
import { withMigrationQueueEvidence } from "../../src/migration/queue-evidence.js";
import { getMigrationReceiptEpoch, recordMigrationReceipt, type MigrationReceiptEnvelope } from "../../src/migration/receipts.js";
import { captureDestinationIdentity, captureDestinationSchemaWitness, verifyMigrationGeneration } from "../../src/migration/verify-generation.js";
import { seedPortableSqlite } from "../storage/sqlite-portable-fixture.js";

/**
 * The real SQLite installation, the transfer-profile role and the verified (or just copied)
 * generation the activation integration tests share. Extracted unchanged from
 * migration-activation.integration.ts so the operator CLI test drives the same installation.
 */

export const EXPECTED_OWNER = "lcm_test_migrator";
/** The activation roles are cluster-wide and unique per run, so a parallel
 * or stale run never shares or drops another run's roles. */
export const TRANSFER_ROLE = "lcm_test_transfer_" + randomBytes(6).toString("hex");
export const RUNTIME_ROLE = "lcm_test_activation_runtime_" + randomBytes(6).toString("hex");
export const GENERATION_ID = "activation-e2e-1";
/** A port nothing in the runner listens on: the restart admission must find no daemon. */
export const DAEMON_PORT = 47331;

export type ProjectMapFile = Record<string, { canonical: string; aliases: string[]; remoteProjectId?: string }>;

export function readProjectMapFile(homeDir: string): ProjectMapFile {
  return JSON.parse(readFileSync(projectMapPath(homeDir), "utf8")) as ProjectMapFile;
}

export function readConfigBackend(homeDir: string): string {
  return (JSON.parse(readFileSync(configPath(homeDir), "utf8")) as { storage: { backend: string } }).storage.backend;
}

const RUNTIME_PROFILE_GRANT_SCRIPTS = [
  "postgresql-runtime-readiness-grants.sql",
  "postgresql-runtime-identity-grants.sql",
  "postgresql-runtime-conversation-grants.sql",
  "postgresql-runtime-summary-context-grants.sql",
  "postgresql-runtime-memory-grants.sql",
  "postgresql-runtime-search-grants.sql",
  "postgresql-runtime-coordination-grants.sql",
  "postgresql-runtime-transcript-grants.sql",
] as const;

/** The reviewed runtime scripts plus the transfer script. */
const TRANSFER_PROFILE_GRANT_SCRIPTS = [
  ...RUNTIME_PROFILE_GRANT_SCRIPTS,
  "postgresql-transfer-grants.sql",
] as const;

export type ActivationRoles = Readonly<{
  transfer: PostgreSqlConnectionSettings;
  runtime: PostgreSqlConnectionSettings;
}>;

/**
 * The activation role, provisioned as an operator would provision the
 * canonical transfer role: a plain login role holding the complete reference
 * transfer profile. The harness's baseline "GRANT USAGE ON SCHEMA lcm TO
 * lcm_test_runtime" is revoked in this database so the activation role is the
 * schema's only non-owner grantee (see the module comment). Returns the
 * role's connection settings for the test database.
 */
export async function provisionActivationRole(db: PostgreSqlTestDatabase): Promise<ActivationRoles> {
  const transferPassword = randomBytes(18).toString("hex");
  const runtimePassword = randomBytes(18).toString("hex");
  const administrator = new PostgreSqlRuntime(settings(db.adminUrl));
  try {
    const run = (text: string, operation: string) => administrator.query({ text }, { domain: "factory", operation });
    for (const [role, password] of [[TRANSFER_ROLE, transferPassword], [RUNTIME_ROLE, runtimePassword]] as const) {
      await run(
        "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '" + role + "') THEN "
          + "CREATE ROLE " + role + " LOGIN; END IF; END $$",
        "createActivationRole",
      );
      await run("ALTER ROLE " + role + " LOGIN PASSWORD '" + password + "'", "setActivationRolePassword");
      await run("GRANT CONNECT ON DATABASE \"" + db.name + "\" TO " + role, "grantActivationRoleConnect");
    }
    await run("REVOKE USAGE ON SCHEMA lcm FROM lcm_test_runtime", "revokeHarnessRuntimeBaseline");
    for (const script of TRANSFER_PROFILE_GRANT_SCRIPTS) {
      const sql = readFileSync(join(process.cwd(), "src/storage/postgresql/reference", script), "utf8")
        .split("\n").filter((line) => !line.startsWith("\\")).join("\n")
        .replaceAll(':"lcm_runtime_role"', '"' + TRANSFER_ROLE + '"')
        .replaceAll(':"lcm_transfer_role"', '"' + TRANSFER_ROLE + '"');
      await run(sql, "grantActivationRole");
    }
  } finally {
    await administrator.close();
  }
  const roleSettings = (role: string, password: string): PostgreSqlConnectionSettings => {
    const url = new URL(db.runtimeUrl);
    url.username = role;
    url.password = password;
    return settings(url.toString());
  };
  return {
    transfer: roleSettings(TRANSFER_ROLE, transferPassword),
    runtime: roleSettings(RUNTIME_ROLE, runtimePassword),
  };
}

/** Apply the runtime profile after verification and immediately before
 * activation, matching the documented grant-first cutover order. */
export async function grantRuntimeActivationRole(
  db: PostgreSqlTestDatabase,
  connectionTemplate: PostgreSqlConnectionSettings,
): Promise<void> {
  const administrator = new PostgreSqlRuntime({ ...connectionTemplate, url: db.adminUrl });
  try {
    for (const script of RUNTIME_PROFILE_GRANT_SCRIPTS) {
      const sql = readFileSync(join(process.cwd(), "src/storage/postgresql/reference", script), "utf8")
        .split("\n").filter((line) => !line.startsWith("\\")).join("\n")
        .replaceAll(':"lcm_runtime_role"', '"' + RUNTIME_ROLE + '"');
      await administrator.query({ text: sql }, { domain: "factory", operation: "grantRuntimeActivationRole" });
    }
  } finally {
    await administrator.close();
  }
}

/**
 * Remove the run's activation role before the harness drops the database: DROP
 * OWNED revokes its grants in this database and on the database itself, which
 * is what lets DROP ROLE succeed for a cluster-wide role. A provisioning
 * failure after CREATE ROLE still leaves the role behind, so this also runs
 * when provisioning did not finish; it is a no-op when the role never came
 * to exist.
 */
export async function dropActivationRole(db: PostgreSqlTestDatabase): Promise<void> {
  const administrator = new PostgreSqlRuntime(settings(db.adminUrl));
  try {
    for (const role of [TRANSFER_ROLE, RUNTIME_ROLE]) {
      const exists = await administrator.query<{ present: boolean }>(
        { text: "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1) AS present", values: [role] },
        { domain: "factory", operation: "activationRoleExists" },
      );
      if (exists.rows[0]?.present !== true) continue;
      await administrator.query({ text: "DROP OWNED BY " + role }, { domain: "factory", operation: "dropActivationRoleOwned" });
      await administrator.query({ text: "DROP ROLE " + role }, { domain: "factory", operation: "dropActivationRole" });
    }
  } finally {
    await administrator.close();
  }
}

export type VerifiedInstallation = Readonly<{
  home: string;
  cwd: string;
  localProjectId: string;
  remoteProjectId: string;
  machineId: string;
  input: MigrationActivationInput;
}>;

/**
 * A real SQLite installation with one enrolled project, copied and verified
 * into the database exactly as the migration-verification e2e does it, with
 * the maintenance window held under the activation's own publication id and
 * the report carrying the real pre-publication project-map witness. Every
 * PostgreSQL access here is the activation role's (plan-v7.2 B1).
 */
export async function prepareVerifiedInstallation(
  db: PostgreSqlTestDatabase,
  home: string,
  transfer: PostgreSqlConnectionSettings,
  runtime: PostgreSqlConnectionSettings,
  options: Readonly<{ stopAfterCopy?: boolean }> = {},
): Promise<VerifiedInstallation> {
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  // The source config the activation republishes with backend postgresql: the
  // composer refuses an absent source config, and the published target must
  // validate as a postgresql config.
  writeFileSync(configPath(home), JSON.stringify({
    storage: { backend: "sqlite", postgresql: { migrationRole: EXPECTED_OWNER } },
    daemon: { port: DAEMON_PORT },
  }) + "\n", { mode: 0o600 });
  const cwd = join(home, "project");
  mkdirSync(cwd, { mode: 0o700 });
  const local = localProjectIdentity(cwd, home);
  const projectDir = join(projectsDir(home), local.id);
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(projectDir, "meta.json"), JSON.stringify({ cwd }) + "\n", { mode: 0o600 });
  // The project-map entry the daemon registers for a project it serves: unbound
  // before activation (S5's pre-publication witness and the composer require an
  // entry that carries no remote binding yet).
  writeFileSync(projectMapPath(home), JSON.stringify({ [local.id]: { canonical: local.canonical, aliases: [] } }) + "\n", { mode: 0o600 });
  clearProjectMapCache();
  const enrolled = await prepareSqliteMigrationEnrollment({
    cwd, homeDir: home,
    targetConfig: {
      backend: "postgresql",
      postgresql: {
        url: transfer.url, caFile: transfer.caFile, poolMax: transfer.poolMax,
        connectionTimeoutMs: transfer.connectionTimeoutMs, idleTimeoutMs: transfer.idleTimeoutMs,
        statementTimeoutMs: transfer.statementTimeoutMs, snapshotIdleTimeoutMs: transfer.snapshotIdleTimeoutMs ?? 300_000,
        migrationRole: EXPECTED_OWNER,
      },
    },
  });
  const identityRuntime = new PostgreSqlRuntime(transfer);
  let remote: Awaited<ReturnType<PostgreSqlIdentityRepository["createProject"]>>;
  try {
    remote = await new PostgreSqlIdentityRepository(identityRuntime).createProject({
      machineId: enrolled.identity.machineId, displayName: "activation e2e target", path: cwd, normalizedPath: cwd,
    });
  } finally {
    await identityRuntime.close();
  }
  const expectedIdentity: StorageIdentityContext = {
    id: remote.projectId, remoteProjectId: remote.projectId, localProjectId: local.id,
    machineId: enrolled.identity.machineId, canonical: cwd, selectedPath: cwd,
  };
  const machine = readMachineIdentity(home)!;
  const seed = seedPortableSqlite(join(projectDir, "db.sqlite"), {
    projectIdentity: { scope: "shared", projectId: remote.projectId }, sourceLocalProjectId: local.id,
    identityFacts: {
      machines: [{ identityKey: machine.identityKey, machineId: machine.machineId }],
      aliases: [{ machineIdentityKey: machine.identityKey, path: cwd, normalizedPath: cwd }],
    },
  });
  if (Array.isArray(seed.capturedSidecars!.instructions)) {
    for (const file of seed.capturedSidecars!.instructions) rmSync(file.databasePath);
  }
  if ("databasePath" in seed.capturedSidecars!.events) rmSync(seed.capturedSidecars!.events.databasePath);
  await appendLocalHookEvents({
    cwd, sessionId: "retained", sourceHook: "SessionStart",
    events: ["applied", "no-effect", "retained"].map((data) => ({ type: "decision", category: "decision", data, priority: 1 })),
  });
  closeLcmConnection();
  const eventsPath = join(home, ".lcm", "events", local.id + ".db");
  const project = new DatabaseSync(join(projectDir, "db.sqlite"));
  const events = new DatabaseSync(eventsPath);
  try {
    const epoch = getMigrationReceiptEpoch(project, local.id, machine.machineId!)!;
    const envelopes = events.prepare(
      "SELECT event_uuid AS eventUuid, event_version AS eventVersion, machine_id AS machineId, "
        + "machine_sequence AS machineSequence, session_id AS sessionId, seq AS sessionSequence, "
        + "type, category, data, priority, source_hook AS sourceHook, created_at AS createdAt "
        + "FROM events ORDER BY machine_sequence",
    ).all() as unknown as MigrationReceiptEnvelope[];
    const memory = project.prepare("SELECT id FROM promoted ORDER BY id LIMIT 1").get() as { id: string };
    project.exec("BEGIN IMMEDIATE");
    for (const [index, envelope] of envelopes.slice(0, 2).entries()) {
      recordMigrationReceipt(project, {
        projectId: local.id, epochId: epoch.epochId, envelope,
        effectWitness: index === 0
          ? { version: 1, outcome: "applied", promotedMemoryId: memory.id }
          : { version: 1, outcome: "no-effect", reason: "unreinforced-pattern" },
        committedAt: "2026-09-14T03:00:00.000000Z",
      });
    }
    project.exec("COMMIT");
    events.exec("UPDATE events SET processed_at='2026-09-14T03:00:00.000Z' WHERE data IN ('applied','no-effect')");
  } finally {
    events.close();
    project.close();
  }
  // The maintenance window is held under the activation's own publication id
  // (deriveActivationPublicationId), the id the S2 lease and the S13 drive
  // carry; the local driver is never reached while the window is only held.
  const unavailable = async (): Promise<never> => { throw new Error("no publication"); };
  const driver: BackendPublicationDriver = {
    observeLocalState: unavailable, publishProjectMap: unavailable, publishConfig: unavailable,
    restoreConfig: unavailable, restoreProjectMap: unavailable,
  };
  const entered = await withBackendPublicationAppendBarrierAsync(home, async (token) => {
    const authority = authenticateSqliteMigrationSource(cwd, home, token);
    const expectedSourceBytes = await authenticateSqliteMigrationSourceBytes(authority, { homeDir: home, lockToken: token });
    // The witness S5 recomputes before compose and S16 reads back after the
    // publication: the real one, over the real map, read under the barrier
    // token exactly as the orchestrator reads it, never a placeholder.
    const projectMapWitnessSha256 = computeMigrationProjectMapWitnessSha256({
      homeDir: home, localProjectId: local.id, remoteProjectId: remote.projectId, mode: "pre-publication", publicationLockToken: token,
    });
    const held = await new BackendPublicationCoordinator({ homeDir: home, driver }).enterMaintenance({
      publicationId: deriveActivationPublicationId(GENERATION_ID), generationId: GENERATION_ID,
      sourceSelectionSha256: authority.sourceSelectionSha256, queueEvidenceSha256: expectedSourceBytes.checksumSha256,
      roster: [{ machineId: machine.machineId!, queueCutoff: "0000000000000000002", evidenceSha256: expectedSourceBytes.checksumSha256 }],
    }, token);
    return { authority, expectedSourceBytes, held, projectMapWitnessSha256 };
  });
  const snapshot = await captureAuthenticatedSqliteMigrationSource(entered.authority, {
    homeDir: home, generationId: entered.held.generationId, maintenanceChecksumSha256: entered.held.checksumSha256,
    expectedSourceBytes: entered.expectedSourceBytes,
  });
  const evidence = await withMigrationQueueEvidence(home, snapshot.artifact, entered.held, async (_reference, records) => [...records]);
  expect(evidence.map((record) => record.disposition)).toEqual(["represented", "represented", "retained"]);
  closeLcmConnection();
  const copyInput = {
    generationId: snapshot.artifact.generationId, homeDir: home, settings: transfer,
    expectedOwner: EXPECTED_OWNER, expectedIdentity, ownerProcessId: "activation-e2e-copy-owner",
    maxRecords: 500, maxBytes: 150994944,
  };
  expect(copyInput.generationId).toBe(GENERATION_ID);
  const witness = await inspectSqliteMigrationCopy({ ...copyInput, destinationCapturedAt: "2026-09-14T03:00:00.000Z" });
  const manifestStore = new MigrationManifestStore({ homeDir: home });
  let created = manifestStore.create(createMigrationManifest({
    generationId: GENERATION_ID, source: witness.source, destination: witness.destination,
    parentGenerationId: null, preservedSourceGenerationId: GENERATION_ID, createdAt: "2026-09-14T03:00:00.000Z",
  }));
  created = manifestStore.update(GENERATION_ID, created.checksumSha256, (current) => beginMigrationEffect(current, {
    kind: "verify-dry-run", effectId: "e2e-dryrun", inputSha256: "a".repeat(64), startedAt: current.updatedAt,
  }));
  manifestStore.update(GENERATION_ID, created.checksumSha256, (current) => completeMigrationEffect(current, {
    effectId: "e2e-dryrun", completedAt: current.updatedAt,
    report: { kind: "dry-run", reportId: "e2e-dryrun-verified", reportSha256: "b".repeat(64), createdAt: current.updatedAt },
  }));
  const copied = await runSqliteMigrationCopy(copyInput);
  expect(copied.phase).toBe("copied");
  if (options.stopAfterCopy === true) {
    // The copy is done and nothing is verified yet: the caller runs verify itself.
    return {
      home, cwd, localProjectId: local.id, remoteProjectId: remote.projectId, machineId: enrolled.identity.machineId,
      input: {
        homeDir: home, generationId: GENERATION_ID, transferSettings: transfer, ordinarySettings: runtime,
        expectedIdentity, expectedOwner: EXPECTED_OWNER,
      },
    };
  }
  const manifest = manifestStore.read(GENERATION_ID);
  const witnessRuntime = new PostgreSqlRuntime(transfer);
  let destinationMigrationsSha256: string;
  let expectedDestinationIdentitySha256: string;
  let expectedSystemIdentifier: string;
  try {
    const [schemaWitness, identity] = await Promise.all([
      captureDestinationSchemaWitness(witnessRuntime),
      captureDestinationIdentity(witnessRuntime, expectedIdentity.id),
    ]);
    destinationMigrationsSha256 = schemaWitness.migrationsSha256;
    expectedDestinationIdentitySha256 = identity.sealedWitnessSha256;
    expectedSystemIdentifier = identity.systemIdentifier;
  } finally {
    await witnessRuntime.close();
  }
  // Under the owned home, so the test's home cleanup removes it.
  const scratchParent = mkdtempSync(join(home, "verify-scratch-"));
  const verified = await verifyMigrationGeneration({
    generationId: GENERATION_ID,
    targetGenerationId: migrationCopyTargetGeneration(GENERATION_ID),
    homeDir: home, expectedIdentity, destinationSettings: transfer,
    expectedOwner: EXPECTED_OWNER, ownerProcessId: "activation-e2e-verify-owner",
    scratchParent, leaseTtlMs: 300000,
    manifestRevision: manifest.revision, manifestChecksumSha256: manifest.checksumSha256,
    destinationMigrationsSha256, expectedDestinationIdentitySha256, expectedSystemIdentifier,
    projectMapWitnessSha256: entered.projectMapWitnessSha256,
    queueClassificationWitness: {
      version: 1, queueCutoff: null, queueSetSha256: "a".repeat(64),
      receiptSetSha256: "a".repeat(64), epochChecksumSha256: "a".repeat(64),
    },
    sampleParameters: { version: 1, strideOrdinal: 97, sampleCount: 32, seedBasisSha256: "a".repeat(64) },
  });
  expect(verified.report.mismatches).toEqual([]);
  expect(verified.report.activationEligible).toBe(true);
  expect(manifestStore.read(GENERATION_ID)).toMatchObject({ phase: "verified", activationEligible: true, pendingEffect: null });
  expect(readBackendMaintenanceJournal(home)).toMatchObject({ phase: "maintenance-held", sourceBackend: "sqlite", generationId: GENERATION_ID });
  expect(readProjectMapFile(home)[local.id]!.remoteProjectId).toBeUndefined();
  return {
    home, cwd, localProjectId: local.id, remoteProjectId: remote.projectId, machineId: enrolled.identity.machineId,
    input: {
      homeDir: home, generationId: GENERATION_ID,
      transferSettings: transfer, ordinarySettings: runtime,
      expectedIdentity, expectedOwner: EXPECTED_OWNER,
    },
  };
}
