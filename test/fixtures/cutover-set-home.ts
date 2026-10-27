import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import {
  BackendPublicationCoordinator,
  resolveBackendMaintenanceGenerationBinding,
  withBackendPublicationAppendBarrierAsync,
  type BackendMaintenanceJournal,
  type BackendPublicationDriver,
} from "../../src/storage/backend-publication.js";
import {
  authenticateSqliteMigrationSource,
  authenticateSqliteMigrationSourceBytes,
  prepareSqliteMigrationEnrollment,
  resolveCutoverSetMemberAuthorities,
  type SqliteMigrationEnrollmentInput,
} from "../../src/migration/maintenance.js";
import { buildCutoverSetManifest } from "../../src/migration/cutover-set.js";
import { localProjectIdentity } from "../../src/daemon/project.js";
import { closeLcmConnection } from "../../src/db/connection.js";
import { clearProjectMapCache } from "../../src/project-map.js";
import * as identityApi from "../../src/machine-identity.js";
import type { IdentityRepository } from "../../src/identity-service.js";
import { SQLiteLocalHookOutboxFactory } from "../../src/storage/local-hook-outbox.js";
import { SqliteStorageBackendFactory } from "../../src/storage/sqlite/factory.js";
import { SET_ID } from "./cutover-set.js";

export const SET_HOME_MACHINE = "018f0b5d-1234-7abc-8def-1234567890ab";
const roots: string[] = [];

afterEach(() => {
  closeLcmConnection();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearProjectMapCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

export function setHomeCoordinator(homeDir: string): BackendPublicationCoordinator {
  const unexpected = async (): Promise<never> => { throw new Error("v2 driver must not run for maintenance"); };
  const driver: BackendPublicationDriver = {
    observeLocalState: unexpected, publishProjectMap: unexpected, publishConfig: unexpected,
    restoreConfig: unexpected, restoreProjectMap: unexpected,
  };
  return new BackendPublicationCoordinator({ homeDir, driver });
}

export type SetHomeProject = Readonly<{ cwd: string; id: string; projectDir: string }>;

function prepareProject(homeDir: string, name: string): SetHomeProject {
  const cwd = join(homeDir, name);
  mkdirSync(cwd, { mode: 0o700 });
  const local = localProjectIdentity(cwd, homeDir);
  const projectDir = join(homeDir, ".lcm", "projects", local.id);
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(projectDir, "meta.json"), JSON.stringify({ cwd }) + "\n", { mode: 0o600 });
  return { cwd, id: local.id, projectDir };
}

/** An enrolled home with `count` projects, each with a project database and a pending outbox event; sorted by project id. */
export async function setHome(count = 2) {
  const homeDir = mkdtempSync(join(tmpdir(), "lcm-cutover-prepare-"));
  mkdirSync(join(homeDir, ".lcm"), { mode: 0o700 });
  mkdirSync(join(homeDir, ".lcm", "events"), { mode: 0o700 });
  roots.push(homeDir);
  const projects = Array.from({ length: count }, (_, index) => prepareProject(homeDir, "project-" + String(index)));
  const request: SqliteMigrationEnrollmentInput = {
    cwd: projects[0]!.cwd, homeDir, targetConfig: { backend: "postgresql", postgresql: {
      url: "postgresql://unused.invalid/lcm", caFile: "/unused", migrationRole: "unused",
      poolMax: 1, connectionTimeoutMs: 100, idleTimeoutMs: 100, statementTimeoutMs: 100,
    } },
  };
  const registered = () => {
    const pending = identityApi.readMachineIdentity(homeDir)!;
    return { machineId: SET_HOME_MACHINE, identityKey: pending.identityKey, displayName: pending.displayName };
  };
  const repository = { registerMachine: vi.fn(async () => registered()), recoverMachine: vi.fn(async () => registered()) };
  await prepareSqliteMigrationEnrollment(request, {
    openIdentitySession: async () => ({ repository: repository as unknown as IdentityRepository, close: async () => undefined }),
  });
  for (const project of projects.slice(1)) {
    const factory = new SqliteStorageBackendFactory({ resolveProject: () => ({ id: project.id, dbPath: join(project.projectDir, "db.sqlite") }) });
    try { await (await factory.openProject({ id: project.id, canonical: project.cwd })).close(); } finally { await factory.close(); }
  }
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

/** Enter the set hold directly through the coordinator, as #1547's contract tests do. */
export async function enterSetHold(homeDir: string, setId = SET_ID) {
  return withBackendPublicationAppendBarrierAsync(homeDir, async (token) => {
    const resolution = resolveCutoverSetMemberAuthorities({ homeDir, lockToken: token });
    if (resolution.status !== "resolved") throw new Error("expected a resolved enumeration");
    const generationIds = new Map(resolution.outcomes.map((outcome, index) =>
      [outcome.physicalProjectId, "member-generation-" + String(index + 1)] as const));
    const built = buildCutoverSetManifest({ setId, machineId: SET_HOME_MACHINE, resolution, generationIds });
    if (built.status !== "built") throw new Error("expected a built set: " + JSON.stringify(built));
    const held = await setHomeCoordinator(homeDir).enterMaintenance(built.entry, token);
    return { built, held, resolution };
  });
}

export async function setMemberCaptureOptions(homeDir: string, held: BackendMaintenanceJournal, project: SetHomeProject, generationId: string) {
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

/** The destination identity a copy source expects for a set member (no database involved). */
export function setMemberIdentity(project: SetHomeProject, index: number) {
  const id = "018f0b5d-1234-7abc-8def-12345678900" + String(index);
  return {
    id, remoteProjectId: id, localProjectId: project.id, machineId: SET_HOME_MACHINE,
    canonical: project.cwd, selectedPath: project.cwd,
  };
}

