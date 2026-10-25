import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";
import { assertHarnessReady, settings, withPostgreSqlTestDatabase, type PostgreSqlTestDatabase } from "./harness.js";
import type { ResolvedPostgreSqlConfig } from "../../src/daemon/config.js";
import { localProjectIdentity } from "../../src/daemon/project.js";
import { closeLcmConnection } from "../../src/db/connection.js";
import { prepareSqliteMigrationEnrollment, assertMigrationReplayAdmission } from "../../src/migration/maintenance.js";
import { prepareCutoverSet, resolveCutoverSetCandidate } from "../../src/migration/cutover-set-prepare.js";
import { activateCutoverSet, createCutoverSetActivateDependencies, type CutoverSetActivateDependencies } from "../../src/migration/cutover-set-activate.js";
import { readCutoverSetActivationRecords } from "../../src/migration/cutover-set-activation-store.js";
import { readActivationGenerationLink } from "../../src/migration/activation-artifact-store.js";
import { readMigrationActivationReport } from "../../src/migration/activation-report.js";
import { readMigrationActivationEvidence } from "../../src/migration/activation-evidence-store.js";
import { resolveMigrationWitnessBindings } from "../../src/migration/generation-binding-store.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { readBackendMaintenanceJournal, readBackendPublicationJournal, type BackendPublicationObserver } from "../../src/storage/backend-publication.js";
import { createBackendPublicationCoordinator } from "../../src/storage/backend-publication-driver.js";
import { createPostgreSqlBackendPublicationRemoteGuard } from "../../src/storage/postgresql/publication-remote-guard.js";
import { SQLiteLocalHookOutboxFactory } from "../../src/storage/local-hook-outbox.js";
import { PostgreSqlIdentityRepository } from "../../src/storage/postgresql/identity-repository.js";
import { readMachineIdentity } from "../../src/machine-identity.js";
import { lcmHomeDir } from "../../src/runtime-paths.js";
import { projectMapPath } from "../../src/project-map.js";
import { seedPortableSqlite } from "../storage/sqlite-portable-fixture.js";
import { applyAllRuntimeGrants } from "./operational-fixture.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import {
  dropActivationRole,
  grantRuntimeActivationRole,
  provisionActivationRole,
} from "./migration-activation-fixture.js";

beforeAll(assertHarnessReady);

/**
 * The assembled #1549 proof against real PostgreSQL: a real two-project
 * SQLite home prepared as a set with the production preparation (#1548's
 * proof), then activated through activateCutoverSet over its production
 * dependencies with nothing substituted: the real append barrier, real
 * fenced leases on lcm.fenced_leases for both destination projects under the
 * set id, the real set quiescence, coverage, snapshot inspection, destination
 * identity resolution, target health and per-member census over fresh
 * read-only transfer snapshots, the real artifact, checkpoint, selection,
 * evidence and binding stores, and the real coordinator over the production
 * driver. One home is carried through the plan's crash chain, (a) after A's
 * link and pending publish before B, (b) selection-completed before the
 * version-2 write, (c) the coordinator crashed with the map published and the
 * config not, (d) A active and B pending, then (e) B's report written and its
 * effect not completed; after every crash the effective home is complete-old
 * or complete-new, every resume adopts the same artifact, publication and
 * frozen witnesses, and the final state is idempotent. A second home proves
 * a destination census mutation refuses the whole set before any effect.
 */
async function twoProjectHome(db: PostgreSqlTestDatabase) {
  const roles = await provisionActivationRole(db);
  const home = mkdtempSync(join(tmpdir(), "cutover-set-activate-"));
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  mkdirSync(join(home, ".lcm", "events"), { mode: 0o700 });
  // The explicit sqlite selection the publication material is composed from (the preparation alone needs none).
  writeFileSync(join(lcmHomeDir(home), "config.json"), JSON.stringify({ storage: { backend: "sqlite" }, daemon: { port: 47331 } }) + "\n", { mode: 0o600 });
  const targetConfig = {
    backend: "postgresql",
    postgresql: { ...roles.transfer, snapshotIdleTimeoutMs: 300_000, migrationRole: "lcm_test_migrator" },
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
  const remotes = new Map<string, string>();
  const transferRuntime = new PostgreSqlRuntime(roles.transfer);
  for (const project of projects) {
    const enrolled = await prepareSqliteMigrationEnrollment({ cwd: project.cwd, homeDir: home, targetConfig });
    const remote = await new PostgreSqlIdentityRepository(transferRuntime).createProject({
      machineId: enrolled.identity.machineId, displayName: "cutover set " + project.id.slice(0, 8), path: project.cwd, normalizedPath: project.cwd,
    });
    remotes.set(project.id, remote.projectId);
    const machine = readMachineIdentity(home)!;
    if (project !== projects[0]) {
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
  await transferRuntime.close();
  const outboxes = new SQLiteLocalHookOutboxFactory();
  for (const project of projects) {
    const outbox = await outboxes.open(join(home, ".lcm", "events", project.id + ".db"));
    await outbox.insertEvent("pending-" + project.id.slice(0, 4), { type: "decision", category: "decision", data: "pending " + project.id, priority: 1 }, "SessionStart");
  }
  await outboxes.close();
  closeLcmConnection();
  return { home, projects, remotes, targetConfig, roles };
}

async function preparedSet(db: PostgreSqlTestDatabase) {
  const installation = await twoProjectHome(db);
  const candidate = await resolveCutoverSetCandidate({ homeDir: installation.home, targetConfig: installation.targetConfig });
  if (candidate.status !== "candidate") throw new Error("expected a candidate: " + JSON.stringify(candidate));
  const prepared = await prepareCutoverSet({
    homeDir: installation.home, confirmSetId: candidate.setId, targetConfig: installation.targetConfig, maxRecords: 500, maxBytes: 16 * 1024 * 1024,
  });
  if (prepared.status !== "prepared") throw new Error("preparation did not finish: " + JSON.stringify(prepared));
  await grantRuntimeActivationRole(db, installation.roles.runtime);
  return { ...installation, setId: candidate.setId, members: candidate.members };
}

function effectiveHome(home: string, projects: readonly { id: string }[], remotes: Map<string, string>) {
  const config = JSON.parse(readFileSync(join(lcmHomeDir(home), "config.json"), "utf8")) as { storage: { backend: string } };
  const map = JSON.parse(readFileSync(projectMapPath(home), "utf8")) as Record<string, { remoteProjectId?: string }>;
  return { backend: config.storage.backend, bound: projects.map((project) => map[project.id]?.remoteProjectId === remotes.get(project.id)) };
}

function expectNotMixed(home: string, projects: readonly { id: string }[], remotes: Map<string, string>): void {
  const state = effectiveHome(home, projects, remotes);
  const bound = state.bound.filter(Boolean).length;
  expect(bound === 0 || bound === projects.length).toBe(true);
  expect(state.backend).toBe(bound === 0 ? "sqlite" : "postgresql");
}

async function fencedLeases(db: PostgreSqlTestDatabase, remoteProjectId: string) {
  const result = await db.migrator.query<{ publication: string; released: boolean }>({
    text: "SELECT owner_process_id AS publication, released_at IS NOT NULL AS released FROM lcm.fenced_leases "
      + "WHERE project_id = $1 AND operation LIKE 'backend-publication:postgresql:%'",
    values: [remoteProjectId],
  }, { domain: "factory", operation: "cutoverSetActivationIntegration" });
  return result.rows;
}

it("activates a prepared two-project set through one publication, resuming identically after every injected crash", async () => {
  await withPostgreSqlTestDatabase("cutover-set-activate", async (db) => {
    const { home, projects, remotes, targetConfig, roles, setId, members } = await preparedSet(db);
    try {
      const deps = createCutoverSetActivateDependencies({ homeDir: home });
      const input = { homeDir: home, confirmSetId: setId, targetConfig, ordinarySettings: roles.runtime };
      const [a, b] = members as [typeof members[number], typeof members[number]];
      const manifests = new MigrationManifestStore({ homeDir: home });
      const crashAt = async (point: string, overrides: Partial<CutoverSetActivateDependencies> = {}) => {
        await expect(activateCutoverSet(input, { ...deps, ...overrides, crashPoint: (p) => { if (p === point) throw new Error("crash at " + point); } }))
          .rejects.toThrow("crash at " + point);
        expectNotMixed(home, projects, remotes);
      };

      // (a) A's link and pending publish-activation exist; B is untouched.
      await crashAt("after-link:" + a.generationId);
      expect(manifests.read(a.generationId).phase).toBe("activating");
      expect(manifests.read(b.generationId).phase).toBe("verified");
      expect(readBackendMaintenanceJournal(home)?.phase).toBe("maintenance-held");
      const checkpoint = readCutoverSetActivationRecords({ homeDir: home, setId });
      if (checkpoint.state !== "resolved") throw new Error("checkpoint missing");
      expect(checkpoint.selection).toBeNull();
      for (const member of members) {
        const leases = await fencedLeases(db, remotes.get(member.physicalProjectId)!);
        expect(leases).toEqual([{ publication: setId, released: false }]);
      }

      // (b) selection-completed, before the version-2 write: all-old, fenced handoff.
      await crashAt("after-selection-completed");
      expect(readBackendMaintenanceJournal(home)?.phase).toBe("selection-completed");
      const frozen = readCutoverSetActivationRecords({ homeDir: home, setId });
      if (frozen.state !== "resolved" || frozen.selection === null) throw new Error("selection not frozen");
      expect(frozen.checkpoint).toEqual(checkpoint.checkpoint);
      for (const row of frozen.selection.members) {
        expect(() => assertMigrationReplayAdmission({ homeDir: home, generationId: row.generationId, evidenceSha256: row.witnessChecksumSha256 }))
          .toThrow(expect.objectContaining({ reason: "unresolved-publication" }));
      }

      // (c) the coordinator crashes with the map published and the config not.
      let crashed = false;
      const crashingCoordinator: CutoverSetActivateDependencies["createCoordinator"] = ({ homeDir, guard, machineId }) => {
        const observer: BackendPublicationObserver = (event) => {
          if (crashed || event !== "after-journal-write") return;
          if (readBackendPublicationJournal(homeDir)?.phase === "map-published") { crashed = true; throw new Error("crash at map-published"); }
        };
        return createBackendPublicationCoordinator({
          homeDir, observer,
          remoteGuard: { mode: "delegated", provider: createPostgreSqlBackendPublicationRemoteGuard({ guard, machineId, ttlMs: 15 * 60 * 1000 }) },
        });
      };
      await expect(activateCutoverSet(input, { ...deps, createCoordinator: crashingCoordinator })).rejects.toThrow("crash at map-published");
      expect(readBackendPublicationJournal(home)?.phase).toBe("map-published");
      // The fenced handoff: the map is published and the config is not, the publication is unresolved, and
      // no member replays; this is the explicitly unresolved state, never an admitted mixed selection.
      expect(effectiveHome(home, projects, remotes)).toEqual({ backend: "sqlite", bound: [true, true] });
      for (const row of frozen.selection.members) {
        expect(() => assertMigrationReplayAdmission({ homeDir: home, generationId: row.generationId, evidenceSha256: row.witnessChecksumSha256 }))
          .toThrow(expect.objectContaining({ reason: "unresolved-publication" }));
      }

      // (d) A active, B pending.
      await crashAt("after-complete:" + a.generationId);
      expect(readBackendPublicationJournal(home)?.phase).toBe("completed");
      expect(manifests.read(a.generationId).phase).toBe("active");
      expect(manifests.read(b.generationId).phase).toBe("activating");
      expect(effectiveHome(home, projects, remotes)).toEqual({ backend: "postgresql", bound: [true, true] });

      // (e) B's report written, its effect not completed: the report is reused.
      await crashAt("after-report:" + b.generationId);

      const outcome = await activateCutoverSet(input, deps);
      expect(outcome).toMatchObject({ status: "activated", setId, publicationId: setId, resumedFrom: "publication-journal" });
      expect(effectiveHome(home, projects, remotes)).toEqual({ backend: "postgresql", bound: [true, true] });
      expect(readBackendMaintenanceJournal(home)).toBeNull();
      const v2 = readBackendPublicationJournal(home);
      expect(v2).toMatchObject({ phase: "completed", publicationId: setId });
      expect(v2!.projects.map((project) => project.localProjectId)).toEqual(projects.map((project) => project.id));
      const digests = new Set<string>();
      for (const row of frozen.selection.members) {
        const manifest = manifests.read(row.generationId);
        expect(manifest.phase).toBe("active");
        const link = readActivationGenerationLink({ homeDir: home, generationId: row.generationId });
        if (link.state !== "resolved") throw new Error("link missing");
        digests.add(link.link.identityDigest);
        expect(link.link.publicationId).toBe(setId);
        const ref = manifest.reports.filter((report) => report.kind === "activation").at(-1)!;
        const report = readMigrationActivationReport({ homeDir: home, generationId: row.generationId, reportSha256: ref.reportSha256 });
        expect(report).toMatchObject({ state: "resolved", report: { body: { publicationId: setId, epochId: row.epochId, attemptId: row.attemptId, witnessChecksumSha256: row.witnessChecksumSha256, identityDigest: frozen.selection.identityDigest } } });
        const evidence = readMigrationActivationEvidence({ homeDir: home, generationId: row.generationId });
        expect(evidence).toMatchObject({ state: "resolved" });
        if (evidence.state === "resolved") expect(evidence.witnesses.some((witness) => witness.checksumSha256 === row.witnessChecksumSha256)).toBe(true);
        expect(resolveMigrationWitnessBindings({ homeDir: home, generationId: row.generationId })).toMatchObject({ state: "resolved", selections: [expect.objectContaining({ publicationId: setId, witnessChecksumSha256: row.witnessChecksumSha256 })] });
        expect(assertMigrationReplayAdmission({ homeDir: home, generationId: row.generationId, evidenceSha256: row.witnessChecksumSha256 })).toEqual({ backend: "postgresql", disposition: "selected" });
        const leases = await fencedLeases(db, row.remoteProjectId);
        expect(leases).toEqual([{ publication: setId, released: true }]);
      }
      expect(digests.size).toBe(1);
      expect([...digests][0]).toBe(frozen.selection.identityDigest);
      // Both destination projects exist, and a second call settles from durable state.
      const count = await db.migrator.query<{ projects: string }>({ text: "SELECT pg_catalog.count(*)::text AS projects FROM lcm.projects" }, { domain: "factory", operation: "diagnosticFixture" });
      expect(count.rows[0]!.projects).toBe("2");
      expect(await activateCutoverSet(input, deps)).toMatchObject({ status: "activated", resumedFrom: "settled-active" });
    } finally {
      await dropActivationRole(db);
      rmSync(home, { recursive: true, force: true });
    }
  });
}, 900000);

it("refuses the whole set before any effect when one member's destination census moved, and releases both leases", async () => {
  await withPostgreSqlTestDatabase("cutover-set-activate-refuse", async (db) => {
    const { home, projects, remotes, targetConfig, roles, setId, members } = await preparedSet(db);
    try {
      const b = members[1]!;
      const remoteB = remotes.get(b.physicalProjectId)!;
      // A row appended to B's destination after verification: its census no longer matches its report.
      await db.migrator.query({
        text: "INSERT INTO lcm.conversations(project_id, session_id, title) VALUES ($1, 'drift-session', 'Drift')",
        values: [remoteB],
      }, { domain: "factory", operation: "cutoverSetActivationDrift" });
      const outcome = await activateCutoverSet({
        homeDir: home,
        confirmSetId: setId,
        targetConfig,
        ordinarySettings: roles.runtime,
      }, createCutoverSetActivateDependencies({ homeDir: home }));
      expect(outcome).toMatchObject({
        status: "refused", step: "S8", reason: "cutover-set-member-evidence-stale", effectBegun: false,
        failures: [{ generationId: b.generationId, reason: "cutover-set-member-evidence-stale" }],
      });
      if (outcome.status === "refused") expect(outcome.members[1]).toMatchObject({ reason: "census-drift" });
      expect(effectiveHome(home, projects, remotes)).toEqual({ backend: "sqlite", bound: [false, false] });
      const manifests = new MigrationManifestStore({ homeDir: home });
      for (const member of members) expect(manifests.read(member.generationId)).toMatchObject({ phase: "verified", pendingEffect: null });
      expect(readBackendMaintenanceJournal(home)?.phase).toBe("maintenance-held");
      expect(readCutoverSetActivationRecords({ homeDir: home, setId })).toEqual({ state: "authoritatively-absent" });
      for (const member of members) {
        const leases = await fencedLeases(db, remotes.get(member.physicalProjectId)!);
        expect(leases.every((lease) => lease.released)).toBe(true);
      }
    } finally {
      await dropActivationRole(db);
      rmSync(home, { recursive: true, force: true });
    }
  });
}, 900000);

it("refuses a third runtime-profile grantee at S6 before leaving a lease", async () => {
  await withPostgreSqlTestDatabase("cutover-set-activate-third-role", async (db) => {
    const { home, remotes, targetConfig, roles, setId, members } = await preparedSet(db);
    try {
      await applyAllRuntimeGrants(db);
      const outcome = await activateCutoverSet({
        homeDir: home,
        confirmSetId: setId,
        targetConfig,
        ordinarySettings: roles.runtime,
      }, createCutoverSetActivateDependencies({ homeDir: home }));
      expect(outcome).toMatchObject({
        status: "refused",
        step: "S6",
        reason: "target-unhealthy",
        effectBegun: false,
      });
      for (const member of members) {
        const leases = await fencedLeases(db, remotes.get(member.physicalProjectId)!);
        expect(leases.length).toBeGreaterThan(0);
        expect(leases.every((lease) => lease.released)).toBe(true);
      }
    } finally {
      await dropActivationRole(db);
      rmSync(home, { recursive: true, force: true });
    }
  });
}, 900000);

