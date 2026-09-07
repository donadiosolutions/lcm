import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { localProjectIdentity } from "../../src/daemon/project.js";
import { authenticateSqliteMigrationSource, authenticateSqliteMigrationSourceBytes, captureAuthenticatedSqliteMigrationSource, prepareSqliteMigrationEnrollment } from "../../src/migration/maintenance.js";
import { PostgreSqlIdentityRepository } from "../../src/storage/postgresql/identity-repository.js";
import {
  assertHarnessReady,
  settings,
  withPostgreSqlTestDatabase,
  type PostgreSqlTestDatabase,
} from "./harness.js";

import { appendLocalHookEvents } from "../../src/hooks/local-enqueue.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { promoteEventsForCwd } from "../../src/daemon/routes/promote-events.js";
import { BackendPublicationCoordinator, withBackendPublicationAppendBarrierAsync, type BackendPublicationDriver } from "../../src/storage/backend-publication.js";
import { inspectAuthenticatedSqliteMigrationSnapshot } from "../../src/migration/queue-evidence.js";
import { assertStorageBackendPublication } from "../../src/storage/backend.js";
import { readMigrationReceiptEvidence } from "../../src/migration/receipts.js";
import { PORTABLE_LIMITS, PORTABLE_RECORD_DOMAIN_ORDER, canonicalSha256, createPortableRecordStream,
  openSqlitePortableSource, type PortableRecordValueByDomain } from "@donadiosolutions/lcm/storage/portable";
import { closeLcmConnection } from "../../src/db/connection.js";

beforeAll(assertHarnessReady);

async function grantIdentityRuntimePrivileges(database: PostgreSqlTestDatabase): Promise<void> {
  const template = readFileSync(
    join(process.cwd(), "src/storage/postgresql/reference/postgresql-runtime-identity-grants.sql"),
    "utf8",
  );
  await database.migrator.query({
    text: template.split("\n").filter((line) => !line.startsWith("\\")).join("\n")
      .replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"'),
  }, { domain: "identity", operation: "grantMigrationEnrollmentIdentity" });
}

describe("SQLite migration enrollment against PostgreSQL 18", () => {
  it("enrolls through PostgreSQL while preserving SQLite and sealing represented and pending input", async () => {
    await withPostgreSqlTestDatabase("migration-enrollment", async (database) => {
      await grantIdentityRuntimePrivileges(database);
      const root = mkdtempSync(join(tmpdir(), "lcm-pg-migration-enrollment-"));
      try {
        const lcm = join(root, ".lcm");
        const cwd = join(root, "project");
        mkdirSync(cwd, { mode: 0o700 });
        mkdirSync(lcm, { mode: 0o700 });
        chmodSync(lcm, 0o700);
        const local = localProjectIdentity(cwd, root);
        const projectDir = join(lcm, "projects", local.id);
        mkdirSync(projectDir, { recursive: true, mode: 0o700 });
        mkdirSync(join(lcm, "events"), { mode: 0o700 });
        writeFileSync(join(projectDir, "meta.json"), `${JSON.stringify({ cwd })}\n`, { mode: 0o600 });
        const repository = new PostgreSqlIdentityRepository(database.runtime);
        vi.stubEnv("HOME", root);
        vi.stubEnv("USERPROFILE", root);
        const enrollmentInput = {
          cwd,
          homeDir: root,
          targetConfig: { backend: "postgresql" as const, postgresql: {
            ...settings(database.runtimeUrl), migrationRole: "lcm_test_migrator",
          } },
          displayName: "Migration enrollment",
        };
        const result = await prepareSqliteMigrationEnrollment(enrollmentInput);
        const retry = await prepareSqliteMigrationEnrollment(enrollmentInput);
        expect(retry.identity).toEqual(result.identity);
        expect(() => assertStorageBackendPublication({ backend: "sqlite", homeDir: root })).not.toThrow();
        await appendLocalHookEvents({ cwd, sessionId: "represented", sourceHook: "SessionStart", events: [
          { type: "decision", category: "decision", data: "Use exact immutable receipts for committed effects", priority: 1 },
          { type: "file_read", category: "file", data: "unreinforced unique file observation", priority: 3 },
        ] });
        const config = loadDaemonConfig(join(lcm, "config.json"));
        expect(config.storage.backend).toBe("sqlite");
        expect(await promoteEventsForCwd(config, cwd)).toMatchObject({ promoted: 1, skipped: 1, errors: 0 });
        const outboxPath = join(lcm, "events", `${local.id}.db`);
        const unused = async (): Promise<never> => { throw new Error("v2 driver must not run"); };
        const driver: BackendPublicationDriver = {
          observeLocalState: unused, publishProjectMap: unused, publishConfig: unused,
          restoreConfig: unused, restoreProjectMap: unused,
        };
        const entered = await withBackendPublicationAppendBarrierAsync(root, async (token) => {
          const authority = authenticateSqliteMigrationSource(cwd, root, token);
          const expectedSourceBytes = await authenticateSqliteMigrationSourceBytes(authority, { homeDir: root, lockToken: token });
          const held = await new BackendPublicationCoordinator({ homeDir: root, driver }).enterMaintenance({
            publicationId: "pg-enrollment-generation", generationId: "pg-enrollment-generation",
            sourceSelectionSha256: authority.sourceSelectionSha256,
            queueEvidenceSha256: expectedSourceBytes.checksumSha256,
            roster: [{ machineId: result.identity.machineId, queueCutoff: "0000000000000000001", evidenceSha256: expectedSourceBytes.checksumSha256 }],
          }, token);
          return { held, expectedSourceBytes };
        });
        // The hold survives returning from its original barrier. A real hook
        // appends before a fresh coordinator and authority resume capture.
        await appendLocalHookEvents({ cwd, sessionId: "pending", sourceHook: "SessionStart", events: [
          { type: "decision", category: "decision", data: "Retain this exact pending input", priority: 1 },
        ] });
        const restarted = new BackendPublicationCoordinator({ homeDir: root, driver });
        expect(restarted.inspectMaintenance()).toEqual(entered.held);
        const authority = await withBackendPublicationAppendBarrierAsync(root, async (token) => authenticateSqliteMigrationSource(cwd, root, token));
        const sourceBytes = readFileSync(join(projectDir, "db.sqlite"));
        const queueBytes = readFileSync(outboxPath);
        const snapshot = await captureAuthenticatedSqliteMigrationSource(authority, {
          homeDir: root, generationId: entered.held.generationId, maintenanceChecksumSha256: entered.held.checksumSha256,
          expectedSourceBytes: entered.expectedSourceBytes,
        });
        expect(snapshot.artifact.maintenanceChecksumSha256).not.toBe(entered.held.checksumSha256);
        expect(snapshot.receiptReference).toMatchObject({ machineId: result.identity.machineId, queueCutoff: "0000000000000000002" });
        expect(snapshot.pages).toHaveLength(1);
        const page = JSON.parse(readFileSync(join(lcm, "migration-evidence", "pg-enrollment-generation", snapshot.pages[0]!.name), "utf8"));
        expect(page.records.map((record: { disposition: string }) => record.disposition)).toEqual(["represented", "represented", "retained"]);
        expect(await inspectAuthenticatedSqliteMigrationSnapshot("pg-enrollment-generation", root)).toEqual(snapshot);
        const artifact = snapshot.artifact;
        const artifactDirectory = join(lcm, "migration-snapshots", "generations", artifact.generationId);
        const projectFile = artifact.roles.find((role) => role.role === "project")!.normalizedMain;
        const eventsFile = artifact.roles.find((role) => role.role === "passive-events")!.normalizedMain;
        const projectCapturePath = join(artifactDirectory, projectFile.relativePath);
        const capturedProject = new DatabaseSync(projectCapturePath, { readOnly: true });
        try {
          expect(readMigrationReceiptEvidence(capturedProject, authority.physicalProjectId,
            authority.machineIdentity.machineId).receipts.map((receipt) => receipt.outcome)).toEqual(["applied", "no-effect"]);
        } finally { capturedProject.close(); }
        const identityFacts = {
          sourceLocalProjectId: authority.physicalProjectId,
          machines: [authority.machineIdentity],
          aliases: [authority.canonicalPath, ...authority.aliases].map((path) => ({
            machineIdentityKey: authority.machineIdentity.identityKey, path, normalizedPath: path,
          })),
        };
        // Consume the accepted package export, using the authenticated artifact
        // hashes and actual receipt-bearing captures, never live source paths.
        const portableSource = await openSqlitePortableSource({
          databasePath: projectCapturePath, expectedFileSha256: projectFile.sha256,
          projectIdentity: authority.projectIdentity, sourceLocalProjectId: authority.physicalProjectId,
          identityFacts, expectedFactsSha256: canonicalSha256(identityFacts), machineIdentityKey: authority.machineIdentity.identityKey,
          capturedSidecars: {
            events: { databasePath: join(artifactDirectory, eventsFile.relativePath), expectedFileSha256: eventsFile.sha256,
              machineIdentityKey: authority.machineIdentity.identityKey },
            // This isolated fixture creates no separate instruction-cache DB.
            instructions: { absent: true, evidenceSha256: snapshot.checksumSha256 },
          },
          capturedAt: artifact.capturedAt.replace(/\.(\d{3})Z$/, (_match, milliseconds: string) => `.${milliseconds}000Z`),
          scratchParent: root,
        });
        const stream = await createPortableRecordStream(portableSource);
        try {
          const manifest = stream.describe();
          expect(manifest.domains.map(({ domain }) => domain)).toEqual(PORTABLE_RECORD_DOMAIN_ORDER);
          expect(manifest.domains.find(({ domain }) => domain === "promoted-memories")?.recordCount).toBe(1);
          expect(manifest.domains.find(({ domain }) => domain === "passive-events")?.recordCount).toBe(3);
          for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
            const batch = await stream.readBatch({ domain, maxRecords: PORTABLE_LIMITS.maxBatchRecords, maxBytes: PORTABLE_LIMITS.maxBatchBytes });
            expect(batch.complete).toBe(true);
            expect(batch.records).toHaveLength(manifest.domains.find((entry) => entry.domain === domain)!.recordCount);
            expect(await stream.verify(batch.checkpoint)).toMatchObject({ authoritative: true, complete: true, matchesManifestBoundary: true });
            if (domain === "passive-events") {
              const events = batch.records.map((record) => record.value as PortableRecordValueByDomain["passive-events"]);
              expect(events.map((event) => ({ sequence: event.machineSequence.$integer, disposition: event.disposition }))
                .sort((left, right) => Number(left.sequence) - Number(right.sequence))).toEqual([
                { sequence: "0", disposition: "applied" }, { sequence: "1", disposition: "applied" }, { sequence: "2", disposition: "pending" },
              ]);
            }
          }
        } finally { await stream.close(); }
        expect(readFileSync(join(projectDir, "db.sqlite"))).toEqual(sourceBytes);
        expect(readFileSync(outboxPath)).toEqual(queueBytes);
        // Postcutoff hooks stay durable while ordinary source consumers are fenced.
        await appendLocalHookEvents({ cwd, sessionId: "postcutoff", sourceHook: "SessionStart", events: [
          { type: "decision", category: "decision", data: "Appended after capture", priority: 1 },
        ] });
        await expect(promoteEventsForCwd(config, cwd)).rejects.toThrow();
        await expect(repository.recoverMachine(result.identity.machineId)).resolves.toMatchObject({
          machineId: result.identity.machineId,
          identityKey: result.identity.identityKey,
        });
        const source = new DatabaseSync(join(projectDir, "db.sqlite"), { readOnly: true });
        const receipts = readMigrationReceiptEvidence(source, local.id, result.identity.machineId);
        expect(receipts.receipts.map((receipt) => receipt.outcome)).toEqual(["applied", "no-effect"]);
        expect(source.prepare(`
          SELECT machine_id, first_machine_sequence
          FROM migration_receipt_v1_epochs
        `).get()).toEqual({
          machine_id: result.identity.machineId,
          first_machine_sequence: "0000000000000000000",
        });
        source.close();
        const outbox = new DatabaseSync(outboxPath, { readOnly: true });
        try {
          expect(outbox.prepare("SELECT machine_id, machine_sequence, processed_at IS NULL AS pending FROM events ORDER BY machine_sequence").all()).toEqual([
            { machine_id: result.identity.machineId, machine_sequence: "0000000000000000000", pending: 0 },
            { machine_id: result.identity.machineId, machine_sequence: "0000000000000000001", pending: 0 },
            { machine_id: result.identity.machineId, machine_sequence: "0000000000000000002", pending: 1 },
            { machine_id: result.identity.machineId, machine_sequence: "0000000000000000003", pending: 1 },
          ]);
        } finally {
          outbox.close();
        }
      } finally {
        closeLcmConnection();
        vi.unstubAllEnvs();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
