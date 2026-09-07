import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, vi } from "vitest";
import * as sqliteConnection from "../../src/db/connection.js";
import { applyBackendPublicationConfigFile } from "../../src/config-manager.js";
import { hashProjectPath, applyBackendPublicationProjectMapFile } from "../../src/project-map.js";
import {
  BackendPublicationCoordinator, assertBackendPublicationConsumerAccess,
  captureBackendPublicationState, readBackendPublicationJournal,
  type BackendPublicationDriver, type BackendPublicationFileMutationContext,
  type BackendPublicationRecoveryFile,
} from "../../src/storage/backend-publication.js";
import { PostgreSqlIdentityRepository, type RegisteredMachine, type RemoteProject } from "../../src/storage/postgresql/identity-repository.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import { SqliteStorageBackendFactory } from "../../src/storage/sqlite/factory.js";
import { settings, type PostgreSqlTestDatabase, withPostgreSqlTestDatabase } from "./harness.js";

const RUNTIME_GRANT_SCRIPTS = [
  "postgresql-runtime-readiness-grants.sql",
  "postgresql-runtime-identity-grants.sql",
  "postgresql-runtime-conversation-grants.sql",
  "postgresql-runtime-summary-context-grants.sql",
  "postgresql-runtime-memory-grants.sql",
  "postgresql-runtime-search-grants.sql",
  "postgresql-runtime-coordination-grants.sql",
  "postgresql-runtime-transcript-grants.sql",
] as const;

function quotePostgreSqlRole(role: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(role)) {
    throw new Error("unsafe PostgreSQL test role identifier");
  }
  return `"${role}"`;
}

async function applyRuntimeGrantScript(
  administrator: PostgreSqlRuntime,
  fileName: string,
  operation: string,
): Promise<void> {
  const template = readFileSync(
    join(process.cwd(), "src/storage/postgresql/reference", fileName),
    "utf8",
  );
  const sql = template
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n")
    .replaceAll(":\"lcm_runtime_role\"", quotePostgreSqlRole("lcm_test_runtime"));
  await administrator.query({ text: sql }, { domain: "factory", operation });
}

/** Reuse the already admitted administrator while selected application env is active. */
export async function restoreRuntimeGrants(administrator: PostgreSqlRuntime): Promise<void> {
  for (const fileName of RUNTIME_GRANT_SCRIPTS) {
    await applyRuntimeGrantScript(
      administrator,
      fileName,
      `apply${fileName.replaceAll(/[^A-Za-z0-9]/gu, "")}`,
    );
  }
}

export async function applyAllRuntimeGrants(database: PostgreSqlTestDatabase): Promise<void> {
  const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
  try {
    await restoreRuntimeGrants(administrator);
  } finally {
    await administrator.close();
  }
}

function recoveryFile(content: string): BackendPublicationRecoveryFile {
  const bytes = Buffer.from(content);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  return {
    presence: "present",
    content: bytes,
    mode: 0o600,
    uid,
    gid,
    nlink: "1",
    dev: "1",
    ino: "2",
    parentDev: "3",
    parentIno: "4",
  };
}

function publicationDriver(homeDir: string): BackendPublicationDriver {
  return {
    observeLocalState: async () => captureBackendPublicationState(homeDir),
    publishProjectMap: (input: BackendPublicationFileMutationContext) =>
      applyBackendPublicationProjectMapFile(input),
    publishConfig: (input: BackendPublicationFileMutationContext) =>
      applyBackendPublicationConfigFile(input),
    restoreConfig: (input: BackendPublicationFileMutationContext) =>
      applyBackendPublicationConfigFile(input),
    restoreProjectMap: (input: BackendPublicationFileMutationContext) =>
      applyBackendPublicationProjectMapFile(input),
  };
}

async function publishPostgreSqlSelection(
  homeDir: string,
  machine: RegisteredMachine,
  project: RemoteProject,
  projectPath: string,
): Promise<void> {
  const lcmDir = join(homeDir, ".lcm");
  mkdirSync(lcmDir, { recursive: true, mode: 0o700 });
  const sourceConfig = "{\"storage\":{\"backend\":\"sqlite\"}}\n";
  const sourceMap = "{}\n";
  const targetConfig = "{\"storage\":{\"backend\":\"postgresql\"}}\n";
  const targetMap = `${JSON.stringify({
    [hashProjectPath(projectPath)]: {
      canonical: projectPath,
      aliases: [],
      remoteProjectId: project.projectId,
    },
  })}\n`;
  writeFileSync(join(lcmDir, "config.json"), sourceConfig, { mode: 0o600 });
  writeFileSync(join(lcmDir, "map.json"), sourceMap, { mode: 0o600 });

  const coordinator = new BackendPublicationCoordinator({
    homeDir,
    driver: publicationDriver(homeDir),
  });
  await coordinator.prepare({
    publicationId: `operational-${machine.machineId}`,
    sourceBackend: "sqlite",
    targetBackend: "postgresql",
    material: {
      source: {
        config: recoveryFile(sourceConfig),
        projectMap: recoveryFile(sourceMap),
      },
      target: {
        config: recoveryFile(targetConfig),
        projectMap: recoveryFile(targetMap),
      },
    },
    projects: [{
      localProjectId: hashProjectPath(projectPath),
      remoteProjectId: project.projectId,
      evidenceSha256: createHash("sha256").update(projectPath).digest("hex"),
    }],
  });
  await expect(coordinator.resume()).resolves.toMatchObject({
    phase: "completed",
    targetBackend: "postgresql",
  });
  expect(readBackendPublicationJournal(homeDir)).toMatchObject({
    phase: "completed",
    targetBackend: "postgresql",
  });
  expect(() => assertBackendPublicationConsumerAccess({
    backend: "postgresql",
    homeDir,
  })).not.toThrow();
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

export interface SelectedPostgreSqlProject {
  database: PostgreSqlTestDatabase;
  administrator: PostgreSqlRuntime;
  homeDir: string;
  projectRoot: string;
  projectPath: string;
  machine: RegisteredMachine;
  project: RemoteProject;
}

/** Real selected backend admission with private local authority and database. */
export async function withSelectedPostgreSqlProject(
  label: string,
  callback: (fixture: SelectedPostgreSqlProject) => Promise<void>,
): Promise<void> {
  await withPostgreSqlTestDatabase(label, async (database) => {
    await applyAllRuntimeGrants(database);
    const homeDir = mkdtempSync(join(tmpdir(), "lcm-pg-operational-home-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "lcm-pg-operational-project-"));
    const projectPath = join(projectRoot, "project");
    mkdirSync(projectPath);
    const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
    const repository = new PostgreSqlIdentityRepository(database.migrator);
    const machine = await repository.registerMachine(
      `machine:${createHash("sha256").update(projectPath).digest("hex")}`,
      "PostgreSQL operational integration",
    );
    const project = await repository.createProject({
      machineId: machine.machineId,
      displayName: "PostgreSQL operational integration project",
      path: projectPath,
      normalizedPath: resolve(projectPath),
    });
    const environmentNames = [
      "HOME", "USERPROFILE", "LCM_POSTGRES_URL", "LCM_POSTGRES_CA_FILE",
      "LCM_POSTGRES_MIGRATION_ROLE",
    ] as const;
    const originalEnvironment = new Map(environmentNames.map(name => [name, process.env[name]]));
    const sqliteProjectExists = vi.spyOn(SqliteStorageBackendFactory.prototype, "projectExists")
      .mockRejectedValue(new Error("project SQLite fallback sentinel"));
    const sqliteOpenExisting = vi.spyOn(SqliteStorageBackendFactory.prototype, "openExistingProject")
      .mockRejectedValue(new Error("project SQLite fallback sentinel"));
    const sqliteOpenProject = vi.spyOn(SqliteStorageBackendFactory.prototype, "openProject")
      .mockRejectedValue(new Error("project SQLite fallback sentinel"));
    const sqlitePathInspection = vi.spyOn(sqliteConnection, "inspectExistingLcmDatabasePath")
      .mockImplementation(() => { throw new Error("project SQLite inspection sentinel"); });
    try {
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      process.env.LCM_POSTGRES_URL = database.runtimeUrl;
      process.env.LCM_POSTGRES_CA_FILE = process.env.LCM_TEST_POSTGRES_CA_FILE;
      process.env.LCM_POSTGRES_MIGRATION_ROLE = "lcm_test_migrator";
      mkdirSync(join(homeDir, ".lcm"), { recursive: true, mode: 0o700 });
      writeFileSync(join(homeDir, ".lcm", "machine.json"), JSON.stringify({
        version: 1, identityKey: machine.identityKey,
        machineId: machine.machineId, displayName: machine.displayName,
      }) + "\n", { mode: 0o600 });
      await publishPostgreSqlSelection(homeDir, machine, project, projectPath);
      await callback({ database, administrator, homeDir, projectRoot, projectPath, machine, project });
      expect(existsSync(join(homeDir, ".lcm", "projects", hashProjectPath(projectPath), "db.sqlite"))).toBe(false);
      expect(sqliteProjectExists).not.toHaveBeenCalled();
      expect(sqliteOpenExisting).not.toHaveBeenCalled();
      expect(sqliteOpenProject).not.toHaveBeenCalled();
      expect(sqlitePathInspection).not.toHaveBeenCalled();
    } finally {
      sqlitePathInspection.mockRestore();
      sqliteOpenProject.mockRestore();
      sqliteOpenExisting.mockRestore();
      sqliteProjectExists.mockRestore();
      for (const name of environmentNames) restoreEnvironment(name, originalEnvironment.get(name));
      await administrator.close();
      rmSync(homeDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
}
