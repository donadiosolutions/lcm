import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";
import { assertHarnessReady, settings, withPostgreSqlTestDatabase, type PostgreSqlTestDatabase } from "./harness.js";
import { grantPortablePostgreSql } from "./portable-fixture.js";
import { applyAllRuntimeGrants } from "./operational-fixture.js";
import type { ResolvedPostgreSqlConfig } from "../../src/daemon/config.js";
import { localProjectIdentity } from "../../src/daemon/project.js";
import { closeLcmConnection } from "../../src/db/connection.js";
import { prepareSqliteMigrationEnrollment, assertMigrationReplayAdmission } from "../../src/migration/maintenance.js";
import { prepareCutoverSet, resolveCutoverSetCandidate } from "../../src/migration/cutover-set-prepare.js";
import { activateCutoverSet, createCutoverSetActivateDependencies } from "../../src/migration/cutover-set-activate.js";
import { readCutoverSetActivationRecords } from "../../src/migration/cutover-set-activation-store.js";
import { createCutoverSetRollbackDependencies, rollbackCutoverSet, type CutoverSetRollbackDependencies } from "../../src/migration/cutover-set-rollback.js";
import { deriveCutoverSetRollbackSetId, readCutoverSetRollbackRecords } from "../../src/migration/cutover-set-rollback-store.js";
import { resolveMigrationWitnessBindings } from "../../src/migration/generation-binding-store.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { readRollbackReport } from "../../src/migration/rollback.js";
import { readBackendMaintenanceJournal, readBackendPublicationJournal, type BackendPublicationObserver } from "../../src/storage/backend-publication.js";
import { createBackendPublicationCoordinator } from "../../src/storage/backend-publication-driver.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import { createPostgreSqlBackendPublicationRemoteGuard } from "../../src/storage/postgresql/publication-remote-guard.js";
import { SQLiteLocalHookOutboxFactory } from "../../src/storage/local-hook-outbox.js";
import { PostgreSqlIdentityRepository } from "../../src/storage/postgresql/identity-repository.js";
import { readMachineIdentity } from "../../src/machine-identity.js";
import { lcmHomeDir } from "../../src/runtime-paths.js";
import { projectMapPath } from "../../src/project-map.js";
import { seedPortableSqlite } from "../storage/sqlite-portable-fixture.js";

beforeAll(assertHarnessReady);

/**
 * The assembled #1550 proof against real PostgreSQL: a real two-project
 * SQLite home prepared and activated as a set with the production #1548 and
 * #1549 services, then rolled back through rollbackCutoverSet over its
 * production dependencies with nothing substituted: the real append barrier,
 * the real postgresql-origin hold and cutoff rebinds, real fenced leases on
 * lcm.fenced_leases for both destination projects under the rollback's id,
 * the real set quiescence and recovery admission, real readbacks over fresh
 * read-only snapshots (A unchanged since its activation: pre-write; B
 * written after it: post-write, exported through the real transfer
 * snapshot), the real builds, installs, sidecars, witness and install
 * records, the real reverse artifact, checkpoint, selection, evidence and
 * binding stores, and the real coordinator over the production driver. One
 * home is carried through a crash chain: (a) the hold, (b) A installed and
 * recorded before B, (c) selection-completed before the reverse version-2
 * write, (d) the coordinator crashed with the map unbound and the config
 * not, (e) A completed and B pending; after every crash the effective home is
 * complete-postgresql or complete-sqlite (or the explicitly unresolved fenced
 * handoff), every resume adopts the same checkpoint, artifact, publication
 * and frozen witnesses, and the final state is idempotent and refuses the
 * forward activation.
 */
async function twoProjectHome(db: PostgreSqlTestDatabase, options: Readonly<{ firstMemberAlias?: boolean }> = {}) {
  await grantPortablePostgreSql(db, { transfer: true });
  const home = mkdtempSync(join(tmpdir(), "cutover-set-rollback-"));
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  mkdirSync(join(home, ".lcm", "events"), { mode: 0o700 });
  writeFileSync(join(lcmHomeDir(home), "config.json"), JSON.stringify({ storage: { backend: "sqlite" }, daemon: { port: 47332 } }) + "\n", { mode: 0o600 });
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
    return { cwd, id: local.id, canonical: local.canonical };
  }).sort((left, right) => (left.id < right.id ? -1 : 1));
  // #1678: the first member's project-map entry carries one extra alias path before enrollment.
  const alias = join(home, "moved-project-a");
  if (options.firstMemberAlias === true) {
    writeFileSync(projectMapPath(home), JSON.stringify({ [projects[0]!.id]: { canonical: projects[0]!.canonical, aliases: [alias] } }) + "\n", { mode: 0o600 });
  }
  const remotes = new Map<string, string>();
  for (const project of projects) {
    const enrolled = await prepareSqliteMigrationEnrollment({ cwd: project.cwd, homeDir: home, targetConfig });
    const remote = await new PostgreSqlIdentityRepository(db.runtime).createProject({
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
  const outboxes = new SQLiteLocalHookOutboxFactory();
  for (const project of projects) {
    const outbox = await outboxes.open(join(home, ".lcm", "events", project.id + ".db"));
    await outbox.insertEvent("pending-" + project.id.slice(0, 4), { type: "decision", category: "decision", data: "pending " + project.id, priority: 1 }, "SessionStart");
  }
  await outboxes.close();
  // donadiosolutions/lcm#1663: the rollback's sidecar verifier (rollback-sidecars.ts, outside this proof) compares the
  // live outbox row's created_at text with the archive's canonical form, so the pending rows carry that form from the
  // start; nothing else about the events changes.
  for (const project of projects) {
    const events = new DatabaseSync(join(home, ".lcm", "events", project.id + ".db"));
    try {
      events.exec("UPDATE events SET created_at = strftime('%Y-%m-%dT%H:%M:%S', created_at) || '.000000Z'");
    } finally {
      events.close();
    }
  }
  closeLcmConnection();
  return { home, projects, remotes, targetConfig, alias };
}

async function activatedSet(db: PostgreSqlTestDatabase, options: Readonly<{ firstMemberAlias?: boolean }> = {}) {
  const installation = await twoProjectHome(db, options);
  const candidate = await resolveCutoverSetCandidate({ homeDir: installation.home, targetConfig: installation.targetConfig });
  if (candidate.status !== "candidate") throw new Error("expected a candidate: " + JSON.stringify(candidate));
  const prepared = await prepareCutoverSet({
    homeDir: installation.home, confirmSetId: candidate.setId, targetConfig: installation.targetConfig, maxRecords: 500, maxBytes: 16 * 1024 * 1024,
  });
  if (prepared.status !== "prepared") throw new Error("preparation did not finish: " + JSON.stringify(prepared));
  const activated = await activateCutoverSet(
    { homeDir: installation.home, confirmSetId: candidate.setId, targetConfig: installation.targetConfig },
    createCutoverSetActivateDependencies({ homeDir: installation.home }),
  );
  if (activated.status !== "activated") throw new Error("activation did not finish: " + JSON.stringify(activated));
  closeLcmConnection();
  await restoreRuntimeProfile(db);
  return { ...installation, setId: candidate.setId, members: candidate.members };
}

/**
 * The harness grants the transfer profile to the one test role the activation copied through. Production rolls a
 * set back through the ordinary runtime role selected by config.json, whose readiness rejects exactly those extra
 * privileges, so the test role returns to the reviewed runtime profile once the activation is published.
 */
async function restoreRuntimeProfile(db: PostgreSqlTestDatabase): Promise<void> {
  const revoke = readFileSync(join(process.cwd(), "src/storage/postgresql/reference", "postgresql-transfer-grants.sql"), "utf8")
    .split("\n").filter((line) => !line.startsWith("\\")).join("\n")
    .replaceAll("GRANT ", "REVOKE ").replaceAll('TO :"lcm_runtime_role"', 'FROM "lcm_test_runtime"');
  const administrator = new PostgreSqlRuntime(settings(db.adminUrl));
  try {
    await administrator.query({ text: revoke }, { domain: "factory", operation: "revokeTransferGrants" });
  } finally {
    await administrator.close();
  }
  await applyAllRuntimeGrants(db);
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
  const result = await db.migrator.query<{ publication: string; operation: string; released: boolean }>({
    text: "SELECT owner_process_id AS publication, operation, released_at IS NOT NULL AS released FROM lcm.fenced_leases "
      + "WHERE project_id = $1 AND operation LIKE 'backend-publication:%' ORDER BY fencing_token",
    values: [remoteProjectId],
  }, { domain: "factory", operation: "cutoverSetRollbackIntegration" });
  return result.rows;
}

it("rolls an activated two-project set back into new sqlite generations through one reverse publication, resuming identically after every injected crash", async () => {
  await withPostgreSqlTestDatabase("cutover-set-rollback", async (db) => {
    const { home, projects, remotes, targetConfig, setId, members } = await activatedSet(db);
    // The connection secrets never live in config.json: the rollback reads the selected postgresql configuration
    // from the home and its secrets from the environment, as the daemon does.
    const previous = { url: process.env.LCM_POSTGRES_URL, caFile: process.env.LCM_POSTGRES_CA_FILE, role: process.env.LCM_POSTGRES_MIGRATION_ROLE };
    const connection = settings(db.runtimeUrl);
    process.env.LCM_POSTGRES_URL = connection.url;
    if (connection.caFile === undefined) delete process.env.LCM_POSTGRES_CA_FILE; else process.env.LCM_POSTGRES_CA_FILE = connection.caFile;
    process.env.LCM_POSTGRES_MIGRATION_ROLE = "lcm_test_migrator";
    try {
      const rollbackSetId = deriveCutoverSetRollbackSetId(setId);
      const [a, b] = members as [typeof members[number], typeof members[number]];
      const remoteA = remotes.get(a.physicalProjectId)!;
      const remoteB = remotes.get(b.physicalProjectId)!;
      const manifests = new MigrationManifestStore({ homeDir: home });
      const activation = readCutoverSetActivationRecords({ homeDir: home, setId });
      if (activation.state !== "resolved" || activation.selection === null) throw new Error("activation selection missing");
      expect(effectiveHome(home, projects, remotes)).toEqual({ backend: "postgresql", bound: [true, true] });
      // B is written after its activation epoch: its rollback is post-write and exports the written row; A stays pre-write.
      await db.migrator.query({
        text: "INSERT INTO lcm.conversations(project_id, session_id, title) VALUES ($1, 'post-write-session', 'Written after activation')",
        values: [remoteB],
      }, { domain: "factory", operation: "cutoverSetRollbackPostWrite" });

      const deps = createCutoverSetRollbackDependencies({ homeDir: home });
      const input = { homeDir: home, confirmSetId: setId };
      const crashAt = async (point: string, overrides: Partial<CutoverSetRollbackDependencies> = {}) => {
        await expect(rollbackCutoverSet(input, { ...deps, ...overrides, crashPoint: (p) => { if (p === point) throw new Error("crash at " + point); } }))
          .rejects.toThrow("crash at " + point);
        expectNotMixed(home, projects, remotes);
      };

      // (a) the postgresql-origin hold: the checkpoint and reverse artifact exist, the old activation evidence is fenced,
      // no member moved and no session has opened yet (the activation's released lease row is still the only row).
      await crashAt("after-hold");
      expect(readBackendMaintenanceJournal(home)).toMatchObject({ phase: "maintenance-held", sourceBackend: "postgresql", generationId: rollbackSetId });
      const checkpoint = readCutoverSetRollbackRecords({ homeDir: home, originalSetId: setId });
      if (checkpoint.state !== "resolved") throw new Error("checkpoint missing");
      expect(checkpoint.selection).toBeNull();
      expect(checkpoint.checkpoint).toMatchObject({ setId: rollbackSetId, originalSetId: setId, activationIdentityDigest: activation.selection.identityDigest });
      for (const member of members) {
        expect(manifests.read(member.generationId)).toMatchObject({ phase: "active", pendingEffect: null });
        expect(await fencedLeases(db, remotes.get(member.physicalProjectId)!)).toEqual([{ publication: setId, operation: expect.stringMatching(/^backend-publication:postgresql:/u), released: true }]);
      }
      for (const row of activation.selection.members) {
        expect(() => assertMigrationReplayAdmission({ homeDir: home, generationId: row.generationId, evidenceSha256: row.witnessChecksumSha256 }))
          .toThrow(expect.objectContaining({ reason: "unresolved-publication" }));
      }

      // (b) A's candidate is built, installed beside its preempted original and recorded; B is still pending its publish.
      await crashAt("after-install-record:" + a.generationId);
      const installed = readCutoverSetRollbackRecords({ homeDir: home, originalSetId: setId });
      if (installed.state !== "resolved") throw new Error("records missing");
      expect(installed.checkpoint).toEqual(checkpoint.checkpoint);
      expect(installed.selection).toBeNull();
      expect([...installed.installs.keys()]).toEqual([a.generationId]);
      expect(manifests.read(a.generationId)).toMatchObject({ phase: "rolling-back", pendingEffect: expect.objectContaining({ kind: "publish-rollback" }) });
      expect(effectiveHome(home, projects, remotes)).toEqual({ backend: "postgresql", bound: [true, true] });
      // The rollback's lease replaced the activation's released row: one live row per destination project, under the rollback's id.
      for (const member of members) {
        expect(await fencedLeases(db, remotes.get(member.physicalProjectId)!)).toEqual([{ publication: rollbackSetId, operation: expect.stringMatching(/^backend-publication:sqlite:/u), released: false }]);
      }

      // (c) selection-completed before the reverse version-2 write: the frozen tuple names both witnesses, nothing replays.
      await crashAt("after-selection-completed");
      expect(readBackendMaintenanceJournal(home)?.phase).toBe("selection-completed");
      const frozen = readCutoverSetRollbackRecords({ homeDir: home, originalSetId: setId });
      if (frozen.state !== "resolved" || frozen.selection === null) throw new Error("selection not frozen");
      expect(frozen.checkpoint).toEqual(checkpoint.checkpoint);
      expect(frozen.selection.members.map((row) => row.generationId)).toEqual([a.generationId, b.generationId]);
      expect(frozen.selection.members.map((row) => row.mode)).toEqual(["pre-write", "post-write"]);
      for (const row of frozen.selection.members) {
        expect(() => assertMigrationReplayAdmission({ homeDir: home, generationId: row.generationId, evidenceSha256: row.witnessChecksumSha256 }))
          .toThrow(expect.objectContaining({ reason: "unresolved-publication" }));
      }

      // (d) the coordinator crashes with the map unbound and the config still selecting postgresql: the fenced handoff.
      let crashed = false;
      const crashingCoordinator: CutoverSetRollbackDependencies["createCoordinator"] = ({ homeDir, guard, machineId }) => {
        const observer: BackendPublicationObserver = (event) => {
          if (crashed || event !== "after-journal-write") return;
          if (readBackendPublicationJournal(homeDir)?.phase === "map-published") { crashed = true; throw new Error("crash at map-published"); }
        };
        return createBackendPublicationCoordinator({
          homeDir, observer,
          remoteGuard: { mode: "delegated", provider: createPostgreSqlBackendPublicationRemoteGuard({ guard, machineId, ttlMs: 15 * 60 * 1000 }) },
        });
      };
      await expect(rollbackCutoverSet(input, { ...deps, createCoordinator: crashingCoordinator })).rejects.toThrow("crash at map-published");
      expect(readBackendPublicationJournal(home)).toMatchObject({ phase: "map-published", publicationId: rollbackSetId });
      expect(effectiveHome(home, projects, remotes)).toEqual({ backend: "postgresql", bound: [false, false] });
      for (const row of frozen.selection.members) {
        expect(() => assertMigrationReplayAdmission({ homeDir: home, generationId: row.generationId, evidenceSha256: row.witnessChecksumSha256 }))
          .toThrow(expect.objectContaining({ reason: "unresolved-publication" }));
      }

      // (e) the reverse publication is completed, A is rolled back and B still pending its completion.
      await crashAt("after-complete:" + a.generationId);
      expect(readBackendPublicationJournal(home)).toMatchObject({ phase: "completed", publicationId: rollbackSetId });
      expect(manifests.read(a.generationId).phase).toBe("rolled-back");
      expect(manifests.read(b.generationId).phase).toBe("rolling-back");
      expect(effectiveHome(home, projects, remotes)).toEqual({ backend: "sqlite", bound: [false, false] });

      const outcome = await rollbackCutoverSet(input, deps);
      expect(outcome).toMatchObject({ status: "rolled-back", originalSetId: setId, setId: rollbackSetId, publicationId: rollbackSetId, resumedFrom: "publication-journal" });
      if (outcome.status !== "rolled-back") throw new Error("unreachable");
      expect(outcome.members.map((member) => [member.generationId, member.mode, member.manifest])).toEqual([[a.generationId, "pre-write", "rolled-back"], [b.generationId, "post-write", "rolled-back"]]);
      expect(effectiveHome(home, projects, remotes)).toEqual({ backend: "sqlite", bound: [false, false] });
      expect(readBackendMaintenanceJournal(home)).toBeNull();
      const v2 = readBackendPublicationJournal(home);
      expect(v2).toMatchObject({ phase: "completed", publicationId: rollbackSetId, sourceBackend: "postgresql", targetBackend: "sqlite" });
      expect(v2!.projects.map((project) => project.localProjectId)).toEqual(projects.map((project) => project.id));
      const final = readCutoverSetRollbackRecords({ homeDir: home, originalSetId: setId });
      if (final.state !== "resolved" || final.selection === null) throw new Error("final records missing");
      expect(final.selection).toEqual(frozen.selection);
      for (const [index, row] of final.selection.members.entries()) {
        const member = members[index]!;
        const manifest = manifests.read(row.generationId);
        expect(manifest).toMatchObject({ phase: "rolled-back", pendingEffect: null });
        expect(manifest.rollbackLineage.mode).toBe(row.mode);
        const ref = manifest.reports.filter((report) => report.kind === "rollback").at(-1)!;
        expect(readRollbackReport(home, row.generationId, ref.reportId)).toMatchObject({ kind: "rollback", mode: row.mode, effectId: "rollback-publish-" + row.witnessChecksumSha256, epochId: row.epochId, attemptId: row.attemptId });
        expect(resolveMigrationWitnessBindings({ homeDir: home, generationId: row.generationId })).toMatchObject({ state: "resolved" });
        const bindings = resolveMigrationWitnessBindings({ homeDir: home, generationId: row.generationId });
        if (bindings.state === "resolved") expect(bindings.selections.at(-1)).toEqual(expect.objectContaining({ kind: "rollback", publicationId: rollbackSetId, witnessChecksumSha256: row.witnessChecksumSha256 }));
        const install = final.installs.get(row.generationId)!;
        expect(outcome.members[index]!.installedGenerationId).toBe(install.installedGenerationId);
        const canonical = join(lcmHomeDir(home), "projects", member.physicalProjectId, "db.sqlite");
        expect(statSync(canonical).size.toString()).toBe(install.database.size);
        // The preempted original is preserved read-only beside the installed candidate.
        expect(install.preemption).not.toBeNull();
        expect(statSync(install.preemption!.path).mode & 0o777).toBe(0o400);
        // Only the member's rollback witness admits sqlite; its activation witness never does again.
        expect(assertMigrationReplayAdmission({ homeDir: home, generationId: row.generationId, evidenceSha256: row.witnessChecksumSha256 })).toEqual({ backend: "sqlite", disposition: "selected" });
        expect(() => assertMigrationReplayAdmission({ homeDir: home, generationId: row.generationId, evidenceSha256: activation.selection!.members[index]!.witnessChecksumSha256 }))
          .toThrow(expect.objectContaining({ reason: "unresolved-publication" }));
        const leases = await fencedLeases(db, remotes.get(member.physicalProjectId)!);
        expect(leases.map((lease) => [lease.publication, lease.released])).toEqual([[rollbackSetId, true]]);
      }
      // The post-write export carried B's row written after activation into its new generation; A's pre-write generation is its preserved source.
      const databaseB = new DatabaseSync(join(lcmHomeDir(home), "projects", b.physicalProjectId, "db.sqlite"), { readOnly: true });
      try {
        expect(databaseB.prepare("SELECT count(*) AS n FROM conversations WHERE session_id = ?").get("post-write-session")).toEqual({ n: 1 });
        expect(databaseB.prepare("SELECT count(*) AS n FROM conversations WHERE session_id = ?").get("cutover-set-second-session")).toEqual({ n: 1 });
      } finally {
        databaseB.close();
      }
      const databaseA = new DatabaseSync(join(lcmHomeDir(home), "projects", a.physicalProjectId, "db.sqlite"), { readOnly: true });
      try {
        expect(databaseA.prepare("SELECT count(*) AS n FROM conversations WHERE session_id = ?").get("post-write-session")).toEqual({ n: 0 });
      } finally {
        databaseA.close();
      }
      expect(remoteA).not.toBe(remoteB);
      // A second call settles from durable state, and the forward activation refuses the rolled-back set without touching it.
      expect(await rollbackCutoverSet(input, deps)).toMatchObject({ status: "rolled-back", resumedFrom: "settled" });
      expect(await activateCutoverSet({ homeDir: home, confirmSetId: setId, targetConfig }, createCutoverSetActivateDependencies({ homeDir: home })))
        .toMatchObject({ status: "refused", reason: "cutover-set-rollback-committed", effectBegun: false });
      expect(effectiveHome(home, projects, remotes)).toEqual({ backend: "sqlite", bound: [false, false] });
    } finally {
      if (previous.url === undefined) delete process.env.LCM_POSTGRES_URL; else process.env.LCM_POSTGRES_URL = previous.url;
      if (previous.caFile === undefined) delete process.env.LCM_POSTGRES_CA_FILE; else process.env.LCM_POSTGRES_CA_FILE = previous.caFile;
      if (previous.role === undefined) delete process.env.LCM_POSTGRES_MIGRATION_ROLE; else process.env.LCM_POSTGRES_MIGRATION_ROLE = previous.role;
      closeLcmConnection();
      rmSync(home, { recursive: true, force: true });
    }
  });
}, 900000);

it("rolls back an activated set whose member carries a project-map alias: the alias is minted by prepare, keeps the lifecycle passing, stays in the local map, and the destination rows are left in place (#1678)", async () => {
  await withPostgreSqlTestDatabase("cutover-set-rollback-alias", async (db) => {
    const { home, projects, remotes, setId, members, alias } = await activatedSet(db, { firstMemberAlias: true });
    const previous = { url: process.env.LCM_POSTGRES_URL, caFile: process.env.LCM_POSTGRES_CA_FILE, role: process.env.LCM_POSTGRES_MIGRATION_ROLE };
    const connection = settings(db.runtimeUrl);
    process.env.LCM_POSTGRES_URL = connection.url;
    if (connection.caFile === undefined) delete process.env.LCM_POSTGRES_CA_FILE; else process.env.LCM_POSTGRES_CA_FILE = connection.caFile;
    process.env.LCM_POSTGRES_MIGRATION_ROLE = "lcm_test_migrator";
    try {
      const [a] = members as [typeof members[number], typeof members[number]];
      const aliasedProject = projects[0]!;
      expect(a.physicalProjectId).toBe(aliasedProject.id);
      const remoteA = remotes.get(aliasedProject.id)!;
      const aliasRows = async () => (await db.migrator.query<{ path: string; normalized_path: string }>({
        text: "SELECT path, normalized_path FROM lcm.project_aliases WHERE project_id = $1 ORDER BY path",
        values: [remoteA],
      }, { domain: "factory", operation: "cutoverSetRollbackAlias" })).rows;
      const expected = [aliasedProject.canonical, alias].sort().map((path) => ({ path, normalized_path: path }));
      // prepare (the fresh mint added the alias to the existing project), verify and activate passed; the project is bound.
      expect(await aliasRows()).toEqual(expected);
      expect(effectiveHome(home, projects, remotes)).toEqual({ backend: "postgresql", bound: [true, true] });
      const readMapAliases = () => (JSON.parse(readFileSync(projectMapPath(home), "utf8")) as Record<string, { aliases: string[] }>)[aliasedProject.id]!.aliases;
      expect(readMapAliases()).toEqual([alias]);

      const deps = createCutoverSetRollbackDependencies({ homeDir: home });
      expect(await rollbackCutoverSet({ homeDir: home, confirmSetId: setId }, deps)).toMatchObject({ status: "rolled-back" });
      expect(effectiveHome(home, projects, remotes)).toEqual({ backend: "sqlite", bound: [false, false] });
      // After rollback the local map still lists the alias, and rollback leaves the destination project and its alias rows in place.
      expect(readMapAliases()).toEqual([alias]);
      expect(await aliasRows()).toEqual(expected);
    } finally {
      if (previous.url === undefined) delete process.env.LCM_POSTGRES_URL; else process.env.LCM_POSTGRES_URL = previous.url;
      if (previous.caFile === undefined) delete process.env.LCM_POSTGRES_CA_FILE; else process.env.LCM_POSTGRES_CA_FILE = previous.caFile;
      if (previous.role === undefined) delete process.env.LCM_POSTGRES_MIGRATION_ROLE; else process.env.LCM_POSTGRES_MIGRATION_ROLE = previous.role;
      closeLcmConnection();
      rmSync(home, { recursive: true, force: true });
    }
  });
}, 900000);
