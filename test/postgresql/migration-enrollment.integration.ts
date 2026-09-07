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
        await appendLocalHookEvents({ cwd, sessionId: "pending", sourceHook: "SessionStart", events: [
          { type: "decision", category: "decision", data: "Retain this exact pending input", priority: 1 },
        ] });
        const sourceBytes = readFileSync(join(projectDir, "db.sqlite"));
        const outboxPath = join(lcm, "events", `${local.id}.db`);
        const queueBytes = readFileSync(outboxPath);
        const unused = async (): Promise<never> => { throw new Error("v2 driver must not run"); };
        const driver: BackendPublicationDriver = {
          observeLocalState: unused, publishProjectMap: unused, publishConfig: unused,
          restoreConfig: unused, restoreProjectMap: unused,
        };
        const snapshot = await withBackendPublicationAppendBarrierAsync(root, async (token) => {
          const authority = authenticateSqliteMigrationSource(cwd, root, token);
          const expectedSourceBytes = await authenticateSqliteMigrationSourceBytes(authority, { homeDir: root, lockToken: token });
          const held = await new BackendPublicationCoordinator({ homeDir: root, driver }).enterMaintenance({
            publicationId: "pg-enrollment-generation", generationId: "pg-enrollment-generation",
            sourceSelectionSha256: authority.sourceSelectionSha256,
            queueEvidenceSha256: expectedSourceBytes.checksumSha256,
            roster: [{ machineId: result.identity.machineId, queueCutoff: "0000000000000000002", evidenceSha256: expectedSourceBytes.checksumSha256 }],
          }, token);
          return captureAuthenticatedSqliteMigrationSource(authority, {
            homeDir: root, generationId: held.generationId, maintenanceChecksumSha256: held.checksumSha256,
            expectedSourceBytes, lockToken: token,
          });
        });
        expect(snapshot.receiptReference).toMatchObject({ machineId: result.identity.machineId, queueCutoff: "0000000000000000002" });
        expect(snapshot.pages).toHaveLength(1);
        const page = JSON.parse(readFileSync(join(lcm, "migration-evidence", "pg-enrollment-generation", snapshot.pages[0]!.name), "utf8"));
        expect(page.records.map((record: { disposition: string }) => record.disposition)).toEqual(["represented", "represented", "retained"]);
        expect(await inspectAuthenticatedSqliteMigrationSnapshot("pg-enrollment-generation", root)).toEqual(snapshot);
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
