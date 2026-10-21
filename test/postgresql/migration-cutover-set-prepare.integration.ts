import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";
import { assertHarnessReady, settings, withPostgreSqlTestDatabase, type PostgreSqlTestDatabase } from "./harness.js";
import { grantPortablePostgreSql } from "./portable-fixture.js";
import type { ResolvedPostgreSqlConfig } from "../../src/daemon/config.js";
import { localProjectIdentity } from "../../src/daemon/project.js";
import { closeLcmConnection } from "../../src/db/connection.js";
import { prepareSqliteMigrationEnrollment } from "../../src/migration/maintenance.js";
import { prepareCutoverSet, resolveCutoverSetCandidate } from "../../src/migration/cutover-set-prepare.js";
import { performMigrationAbortCommand } from "../../src/migration/cli-abort.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { MigrationVerificationReportStore } from "../../src/migration/verification-store.js";
import { readVerifiedEvidence } from "../../src/migration/cli-verify.js";
import { inspectAuthenticatedSqliteMigrationSnapshot } from "../../src/migration/queue-evidence.js";
import {
  readBackendMaintenanceJournal,
  resolveBackendMaintenanceGenerationBinding,
} from "../../src/storage/backend-publication.js";
import { SQLiteLocalHookOutboxFactory } from "../../src/storage/local-hook-outbox.js";
import { PostgreSqlIdentityRepository } from "../../src/storage/postgresql/identity-repository.js";
import { readMachineIdentity } from "../../src/machine-identity.js";
import { seedPortableSqlite } from "../storage/sqlite-portable-fixture.js";

beforeAll(assertHarnessReady);

/**
 * The assembled #1548 proof against real PostgreSQL: a real two-project
 * SQLite home prepared under one maintenance hold with the production
 * capture, genesis, copy and verification code (no stand-ins), then an
 * interrupted preparation that resumes without copying a verified member
 * again.
 */
async function twoProjectHome(db: PostgreSqlTestDatabase) {
  await grantPortablePostgreSql(db, { transfer: true });
  const home = mkdtempSync(join(tmpdir(), "cutover-set-prepare-"));
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  mkdirSync(join(home, ".lcm", "events"), { mode: 0o700 });
  const targetConfig = {
    backend: "postgresql",
    postgresql: { ...settings(db.runtimeUrl), snapshotIdleTimeoutMs: 300_000, migrationRole: "lcm_test_migrator" },
  } as unknown as ResolvedPostgreSqlConfig;
  const projects = ["project-a", "project-b"].map((name) => {
    const cwd = join(home, name);
    mkdirSync(cwd, { mode: 0o700 });
    const local = localProjectIdentity(cwd, home);
    const projectDir = join(home, ".lcm", "projects", local.id);
    mkdirSync(projectDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(projectDir, "meta.json"), JSON.stringify({ cwd }) + "\n", { mode: 0o600 });
    return { cwd, id: local.id };
  }).sort((left, right) => (left.id < right.id ? -1 : 1));
  for (const project of projects) {
    const enrolled = await prepareSqliteMigrationEnrollment({ cwd: project.cwd, homeDir: home, targetConfig });
    // The destination project exists before the preparation, so the identity step reuses it and the
    // seeded source rows carry the very project id the copy will be admitted for.
    const remote = await new PostgreSqlIdentityRepository(db.runtime).createProject({
      machineId: enrolled.identity.machineId, displayName: "cutover set " + project.id.slice(0, 8), path: project.cwd, normalizedPath: project.cwd,
    });
    const machine = readMachineIdentity(home)!;
    if (project !== projects[0]) {
      // Project ids that the destination keys globally (conversation and message ids) must not repeat
      // across the home's projects, so the second project carries its own minimal searchable content
      // instead of a second copy of the shared fixture.
      const database = new DatabaseSync(join(home, ".lcm", "projects", project.id, "db.sqlite"));
      try {
        database.prepare("INSERT INTO conversations(conversation_id,session_id,title,created_at,updated_at) VALUES(72,'cutover-set-second-session','Second project',?,?)")
          .run("2026-09-06 12:00:00.123456", "2026-09-06 12:00:00.123456");
        database.prepare("INSERT INTO messages(message_id,conversation_id,seq,role,content,token_count,created_at) VALUES(84,72,0,'assistant','The second project holds searchable content',6,?)")
          .run("2026-09-06 12:00:00.123456");
      } finally { database.close(); }
      continue;
    }
    const seed = seedPortableSqlite(join(home, ".lcm", "projects", project.id, "db.sqlite"), {
      projectIdentity: { scope: "shared", projectId: remote.projectId }, sourceLocalProjectId: project.id,
      identityFacts: {
        machines: [{ identityKey: machine.identityKey, machineId: machine.machineId }],
        aliases: [{ machineIdentityKey: machine.identityKey, path: project.cwd, normalizedPath: project.cwd }],
      },
    });
    if (Array.isArray(seed.capturedSidecars!.instructions)) {
      for (const file of seed.capturedSidecars!.instructions) rmSync(file.databasePath);
    }
    if ("databasePath" in seed.capturedSidecars!.events) rmSync(seed.capturedSidecars!.events.databasePath);
  }
  const outboxes = new SQLiteLocalHookOutboxFactory();
  for (const project of projects) {
    const outbox = await outboxes.open(join(home, ".lcm", "events", project.id + ".db"));
    await outbox.insertEvent("pending-" + project.id.slice(0, 4), { type: "decision", category: "decision", data: "pending " + project.id, priority: 1 }, "SessionStart");
  }
  await outboxes.close();
  closeLcmConnection();
  return { home, projects, targetConfig };
}

async function expectMembersIntact(home: string, generationIds: readonly string[]) {
  const journal = readBackendMaintenanceJournal(home)!;
  expect(journal.phase).toBe("maintenance-held");
  const manifests = new MigrationManifestStore({ homeDir: home });
  const reports = new MigrationVerificationReportStore({ homeDir: home });
  for (const generationId of generationIds) {
    const view = resolveBackendMaintenanceGenerationBinding(journal, generationId)!;
    const sealed = await inspectAuthenticatedSqliteMigrationSnapshot(generationId, home);
    // Each member's witness, queue cutoff and receipt reference are still its own under the same hold.
    expect(sealed.artifact.maintenanceChecksumSha256).toBe(view.checksumSha256);
    expect(sealed.receiptReference.queueCutoff).toBe(view.roster[0]!.queueCutoff);
    expect(view.roster[0]!.queueCutoff).not.toBeNull();
    expect(manifests.read(generationId)).toMatchObject({ phase: "verified", pendingEffect: null, activationEligible: true });
    expect(readVerifiedEvidence(generationId, manifests, reports, null).status).toBe("verified");
  }
}

async function destinationProjects(db: PostgreSqlTestDatabase): Promise<string> {
  const result = await db.migrator.query<{ projects: string }>({
    text: "SELECT pg_catalog.count(*)::text AS projects FROM lcm.projects",
  }, { domain: "factory", operation: "diagnosticFixture" });
  return result.rows[0]!.projects;
}

it("prepares a two-project home under one hold: both members copied and verified, evidence independent, then released by one abort", async () => {
  await withPostgreSqlTestDatabase("cutover-set-prepare", async (db) => {
    const { home, projects, targetConfig } = await twoProjectHome(db);
    try {
      const candidate = await resolveCutoverSetCandidate({ homeDir: home, targetConfig });
      expect(candidate).toMatchObject({ status: "candidate", disposition: "fresh" });
      if (candidate.status !== "candidate") throw new Error("unreachable");
      expect(await destinationProjects(db)).toBe("2");

      const result = await prepareCutoverSet({
        homeDir: home, confirmSetId: candidate.setId, targetConfig, maxRecords: 500, maxBytes: 16 * 1024 * 1024,
      });
      if (result.status !== "prepared") throw new Error("preparation did not finish: " + JSON.stringify(result));
      expect(result.setId).toBe(candidate.setId);
      expect(result.members.map((member) => [member.physicalProjectId, member.generationId, member.state]))
        .toEqual(candidate.members.map((member) => [member.physicalProjectId, member.generationId, "verified"]));
      expect(result.members.map((member) => member.physicalProjectId)).toEqual(projects.map((project) => project.id));
      expect(await destinationProjects(db)).toBe("2");
      await expectMembersIntact(home, candidate.members.map((member) => member.generationId));

      // Preparing again is a validated no-op for every member.
      const manifests = new MigrationManifestStore({ homeDir: home });
      const before = candidate.members.map((member) => manifests.read(member.generationId));
      expect(await prepareCutoverSet({
        homeDir: home, confirmSetId: candidate.setId, targetConfig, maxRecords: 500, maxBytes: 16 * 1024 * 1024,
      })).toMatchObject({ status: "prepared" });
      expect(candidate.members.map((member) => manifests.read(member.generationId))).toEqual(before);

      // One abort settles both verified members and releases the hold.
      expect(await performMigrationAbortCommand({ homeDir: home, confirmGenerationId: candidate.setId }))
        .toMatchObject({ status: "ok", journalPhase: "maintenance-aborted", manifestPhase: "aborted", applied: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}, 600000);

it("resumes a preparation interrupted during the second member's copy without copying the verified first member again", async () => {
  await withPostgreSqlTestDatabase("cutover-set-resume", async (db) => {
    const { home, targetConfig } = await twoProjectHome(db);
    try {
      const candidate = await resolveCutoverSetCandidate({ homeDir: home, targetConfig });
      if (candidate.status !== "candidate") throw new Error("expected a candidate");
      const [first, second] = candidate.members as [typeof candidate.members[number], typeof candidate.members[number]];
      const limits = { maxRecords: 1, maxBytes: 16 * 1024 * 1024 };
      let sources = 0;
      const interrupted = await prepareCutoverSet({
        homeDir: home, confirmSetId: candidate.setId, targetConfig, ...limits,
        copyTesting: { observe: async (boundary) => {
          if (boundary === "before-source") sources += 1;
          if (sources === 2 && boundary === "after-checkpoint") throw new Error("injected interruption");
        } },
      });
      if (interrupted.status !== "blocked") throw new Error("expected a block: " + JSON.stringify(interrupted));
      expect(interrupted).toMatchObject({ reason: "copy-failed", blockedProject: second.physicalProjectId });
      const manifests = new MigrationManifestStore({ homeDir: home });
      const firstBefore = manifests.read(first.generationId);
      expect(firstBefore.phase).toBe("verified");
      expect(["dry-run-verified", "copying"]).toContain(manifests.read(second.generationId).phase);
      expect(readBackendMaintenanceJournal(home)!.phase).toBe("maintenance-held");

      const resumed = await prepareCutoverSet({ homeDir: home, confirmSetId: candidate.setId, targetConfig, ...limits });
      expect(resumed).toMatchObject({ status: "prepared", setId: candidate.setId });
      // The verified first member was validated, not copied: its manifest did not move.
      expect(manifests.read(first.generationId)).toEqual(firstBefore);
      await expectMembersIntact(home, [first.generationId, second.generationId]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}, 600000);

