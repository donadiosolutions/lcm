import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { ResolvedStorageConfig } from "../../src/daemon/config.js";
import {
  createProject as createIdentityProject,
  type IdentityRepository,
} from "../../src/identity-service.js";
import { recoverMachineIdentity } from "../../src/machine-identity.js";
import { clearProjectMapCache, resolveProjectIdentity } from "../../src/project-map.js";
import {
  PostgreSqlIdentityCreateOutcomeUnknownError,
  type PostgreSqlIdentityExecutor,
  PostgreSqlIdentityConflictError,
  PostgreSqlIdentityRepository,
} from "../../src/storage/postgresql/identity-repository.js";
import { PostgreSqlCommitOutcomeUnknownError } from "../../src/storage/postgresql/errors.js";
import {
  assertHarnessReady,
  type PostgreSqlTestDatabase,
  withPostgreSqlTestDatabase,
} from "./harness.js";

beforeAll(assertHarnessReady);

async function grantIdentityRuntimePrivileges(
  database: PostgreSqlTestDatabase,
): Promise<void> {
  const template = readFileSync(
    join(process.cwd(), "docs", "postgresql-runtime-identity-grants.sql"),
    "utf8",
  );
  const sql = template
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n")
    .replaceAll(':"lcm_runtime_role"', '"lcm_test_runtime"');
  await database.migrator.query({ text: sql }, {
    domain: "identity",
    operation: "grantIdentityRuntimePrivileges",
  });
}

describe("PostgreSQL 18 machine and project identities", () => {
  it("recovers a legacy NULL machine display name with a deterministic fallback", async () => {
    await withPostgreSqlTestDatabase("identity-null-machine-name", async (database) => {
      await grantIdentityRuntimePrivileges(database);
      const inserted = await database.migrator.query<{ machine_id: string }>({
        text: `INSERT INTO lcm.machines (identity_key, display_name)
               VALUES ($1, NULL)
               RETURNING machine_id`,
        values: [`machine:${"f".repeat(64)}`],
      }, { domain: "identity", operation: "insertNullMachineDisplayName" });
      const machineId = inserted.rows[0].machine_id;
      const repository = new PostgreSqlIdentityRepository(database.runtime);

      await expect(repository.recoverMachine(machineId)).resolves.toMatchObject({
        machineId,
        displayName: `Machine ${machineId}`,
      });
    });
  });

  it("fails without identity grants and the reviewed grant script is least-privilege", async () => {
    await withPostgreSqlTestDatabase("identity-grants", async (database) => {
      const identityKey = `machine:${"0".repeat(64)}`;
      const repository = new PostgreSqlIdentityRepository(database.runtime);
      const denied = await repository.registerMachine(identityKey, "Denied")
        .catch((error: unknown) => error);
      expect(denied).toMatchObject({
        backend: "postgresql",
        domain: "identity",
        operation: "registerMachine",
      });
      expect(JSON.stringify(denied)).not.toContain(identityKey);

      await grantIdentityRuntimePrivileges(database);
      await expect(repository.registerMachine(identityKey, "Granted"))
        .resolves.toMatchObject({ displayName: "Granted" });
      const privileges = await database.migrator.query<{
        schema_usage: boolean;
        schema_create: boolean;
        machines_select: boolean;
        machines_insert: boolean;
        machines_update: boolean;
        machines_delete: boolean;
        projects_select: boolean;
        projects_insert: boolean;
        projects_update: boolean;
        projects_delete: boolean;
        aliases_select: boolean;
        aliases_insert: boolean;
        aliases_update: boolean;
        aliases_delete: boolean;
        aliases_truncate: boolean;
      }>({
        text: `SELECT
                 has_schema_privilege('lcm_test_runtime', 'lcm', 'USAGE') AS schema_usage,
                 has_schema_privilege('lcm_test_runtime', 'lcm', 'CREATE') AS schema_create,
                 has_table_privilege('lcm_test_runtime', 'lcm.machines', 'SELECT') AS machines_select,
                 has_table_privilege('lcm_test_runtime', 'lcm.machines', 'INSERT') AS machines_insert,
                 has_table_privilege('lcm_test_runtime', 'lcm.machines', 'UPDATE') AS machines_update,
                 has_table_privilege('lcm_test_runtime', 'lcm.machines', 'DELETE') AS machines_delete,
                 has_table_privilege('lcm_test_runtime', 'lcm.projects', 'SELECT') AS projects_select,
                 has_table_privilege('lcm_test_runtime', 'lcm.projects', 'INSERT') AS projects_insert,
                 has_table_privilege('lcm_test_runtime', 'lcm.projects', 'UPDATE') AS projects_update,
                 has_table_privilege('lcm_test_runtime', 'lcm.projects', 'DELETE') AS projects_delete,
                 has_table_privilege('lcm_test_runtime', 'lcm.project_aliases', 'SELECT') AS aliases_select,
                 has_table_privilege('lcm_test_runtime', 'lcm.project_aliases', 'INSERT') AS aliases_insert,
                 has_table_privilege('lcm_test_runtime', 'lcm.project_aliases', 'UPDATE') AS aliases_update,
                 has_table_privilege('lcm_test_runtime', 'lcm.project_aliases', 'DELETE') AS aliases_delete,
                 has_table_privilege('lcm_test_runtime', 'lcm.project_aliases', 'TRUNCATE') AS aliases_truncate`,
      }, { domain: "identity", operation: "inspectIdentityRuntimePrivileges" });
      expect(privileges.rows[0]).toEqual({
        schema_usage: true,
        schema_create: false,
        machines_select: true,
        machines_insert: true,
        machines_update: true,
        machines_delete: false,
        projects_select: true,
        projects_insert: true,
        projects_update: false,
        projects_delete: true,
        aliases_select: true,
        aliases_insert: true,
        aliases_update: true,
        aliases_delete: true,
        aliases_truncate: false,
      });
    });
  });

  it("converges concurrent machine upserts and lets two machines share one project", async () => {
    await withPostgreSqlTestDatabase("identity-share", async (database) => {
      await grantIdentityRuntimePrivileges(database);
      const repository = new PostgreSqlIdentityRepository(database.runtime);
      const identityKey = `machine:${"a".repeat(64)}`;
      const concurrent = await Promise.all([
        repository.registerMachine(identityKey, "Machine A"),
        repository.registerMachine(identityKey, "Machine A"),
        repository.registerMachine(identityKey, "Machine A"),
      ]);
      expect(new Set(concurrent.map(({ machineId }) => machineId)).size).toBe(1);

      const machineA = concurrent[0];
      const machineB = await repository.registerMachine(
        `machine:${"b".repeat(64)}`,
        "Machine B",
      );
      const project = await repository.createProject({
        machineId: machineA.machineId,
        displayName: "Shared project",
        path: "/srv/a/project",
        normalizedPath: "/srv/a/project",
      });
      const linked = await repository.linkProject({
        machineId: machineB.machineId,
        projectId: project.projectId,
        path: "/opt/b/different-path",
        normalizedPath: "/opt/b/different-path",
      });
      expect(linked.machineId).toBe(machineB.machineId);

      const projects = await repository.listProjects();
      expect(projects).toEqual([
        expect.objectContaining({
          projectId: project.projectId,
          displayName: "Shared project",
          aliases: [
            expect.objectContaining({ machineId: machineA.machineId, path: "/srv/a/project" }),
            expect.objectContaining({ machineId: machineB.machineId, path: "/opt/b/different-path" }),
          ],
        }),
      ]);
    });
  });

  it("enforces path uniqueness, preserves idempotent links, and rolls back failed creates", async () => {
    await withPostgreSqlTestDatabase("identity-conflict", async (database) => {
      await grantIdentityRuntimePrivileges(database);
      const repository = new PostgreSqlIdentityRepository(database.runtime);
      const machine = await repository.registerMachine(
        `machine:${"c".repeat(64)}`,
        "Machine C",
      );
      const first = await repository.createProject({
        machineId: machine.machineId,
        displayName: "First",
        path: "/work/collision",
        normalizedPath: "/work/collision",
      });
      await expect(repository.linkProject({
        machineId: machine.machineId,
        projectId: first.projectId,
        path: "/work/collision",
        normalizedPath: "/work/collision",
      })).resolves.toMatchObject({
        machineId: machine.machineId,
        normalizedPath: "/work/collision",
      });

      const countBefore = await database.migrator.query<{ count: string }>({
        text: "SELECT count(*)::text AS count FROM lcm.projects",
      }, { domain: "identity", operation: "countProjectsBeforeRollback" });
      await expect(repository.createProject({
        machineId: machine.machineId,
        displayName: "Must roll back",
        path: "/work/collision",
        normalizedPath: "/work/collision",
      })).rejects.toBeInstanceOf(PostgreSqlIdentityConflictError);
      const countAfter = await database.migrator.query<{ count: string }>({
        text: "SELECT count(*)::text AS count FROM lcm.projects",
      }, { domain: "identity", operation: "countProjectsAfterRollback" });
      expect(countAfter.rows[0].count).toBe(countBefore.rows[0].count);

      const second = await repository.createProject({
        machineId: machine.machineId,
        displayName: "Second",
        path: "/work/second",
        normalizedPath: "/work/second",
      });
      await expect(repository.linkProject({
        machineId: machine.machineId,
        projectId: second.projectId,
        path: "/work/collision",
        normalizedPath: "/work/collision",
      })).rejects.toMatchObject({
        existingProjectId: first.projectId,
        requestedProjectId: second.projectId,
      });

      const listed = await repository.listProjects();
      expect(listed.map(({ projectId }) => projectId)).toEqual([
        first.projectId,
        second.projectId,
      ]);
      await expect(repository.resolveProject(machine.machineId, "/work/collision"))
        .resolves.toMatchObject({ projectId: first.projectId });
    });
  });

  it("unlinks one alias or all aliases and only deletes unreferenced projects", async () => {
    await withPostgreSqlTestDatabase("identity-unlink", async (database) => {
      await grantIdentityRuntimePrivileges(database);
      const repository = new PostgreSqlIdentityRepository(database.runtime);
      const machine = await repository.registerMachine(
        `machine:${"d".repeat(64)}`,
        "Machine D",
      );
      const project = await repository.createProject({
        machineId: machine.machineId,
        displayName: "Disposable",
        path: "/work/canonical",
        normalizedPath: "/work/canonical",
      });
      await repository.linkProject({
        machineId: machine.machineId,
        projectId: project.projectId,
        path: "/work/alias",
        normalizedPath: "/work/alias",
      });

      await expect(repository.deleteProjectIfUnreferenced(project.projectId)).resolves.toBe(false);
      await expect(repository.unlinkPath(machine.machineId, "/work/alias"))
        .resolves.toMatchObject({ projectId: project.projectId });
      await expect(repository.unlinkProject(machine.machineId, project.projectId)).resolves.toHaveLength(1);
      await expect(repository.deleteProjectIfUnreferenced(project.projectId)).resolves.toBe(true);
      await expect(repository.recoverMachine(machine.machineId))
        .resolves.toMatchObject({ identityKey: `machine:${"d".repeat(64)}` });
    });
  });

  it("restores aliases by expected ownership and cleans up creates atomically", async () => {
    await withPostgreSqlTestDatabase("identity-reconcile", async (database) => {
      await grantIdentityRuntimePrivileges(database);
      const repository = new PostgreSqlIdentityRepository(database.runtime);
      const machine = await repository.registerMachine(
        `machine:${"e".repeat(64)}`,
        "Machine E",
      );
      const original = await repository.createProject({
        machineId: machine.machineId,
        displayName: "Original",
        path: "/work/reconcile",
        normalizedPath: "/work/reconcile",
      });
      const replacement = await repository.createProject({
        machineId: machine.machineId,
        displayName: "Replacement",
        path: "/work/replacement",
        normalizedPath: "/work/replacement",
      });
      const prior = await repository.resolveProject(machine.machineId, "/work/reconcile");
      expect(prior).toMatchObject({ projectId: original.projectId });
      await expect(repository.replaceProjectAlias({
        machineId: machine.machineId,
        expectedPriorProjectId: replacement.projectId,
        projectId: original.projectId,
        path: "/work/reconcile",
        normalizedPath: "/work/reconcile",
      })).resolves.toBeNull();
      await expect(repository.replaceProjectAlias({
        machineId: machine.machineId,
        expectedPriorProjectId: original.projectId,
        projectId: replacement.projectId,
        path: "/work/reconcile",
        normalizedPath: "/work/reconcile",
      })).resolves.toMatchObject({ path: "/work/reconcile" });
      await expect(repository.resolveProject(machine.machineId, "/work/reconcile"))
        .resolves.toMatchObject({ projectId: replacement.projectId });
      await expect(repository.restoreProjectAlias({
        machineId: machine.machineId,
        normalizedPath: "/work/reconcile",
        currentProjectId: replacement.projectId,
        prior,
      })).resolves.toBe(true);
      await expect(repository.resolveProject(machine.machineId, "/work/reconcile"))
        .resolves.toMatchObject({ projectId: original.projectId });
      await expect(repository.restoreProjectAlias({
        machineId: machine.machineId,
        normalizedPath: "/work/reconcile",
        currentProjectId: replacement.projectId,
        prior: null,
      })).resolves.toBe(false);

      await repository.linkProject({
        machineId: machine.machineId,
        projectId: original.projectId,
        path: "/work/reconcile-alias",
        normalizedPath: "/work/reconcile-alias",
      });
      await repository.linkProject({
        machineId: machine.machineId,
        projectId: original.projectId,
        path: "/work/sibling-entry",
        normalizedPath: "/work/sibling-entry",
      });
      const foreign = await repository.createProject({
        machineId: machine.machineId,
        displayName: "Foreign",
        path: "/work/foreign",
        normalizedPath: "/work/foreign",
      });
      const collision = [
        { path: "/work/reconcile", normalizedPath: "/work/reconcile" },
        { path: "/work/foreign", normalizedPath: "/work/foreign" },
      ];
      await expect(repository.replaceProjectAliases({
        machineId: machine.machineId,
        expectedPriorProjectId: original.projectId,
        projectId: replacement.projectId,
        aliases: collision,
      })).resolves.toBeNull();
      await expect(repository.resolveProject(machine.machineId, "/work/reconcile"))
        .resolves.toMatchObject({ projectId: original.projectId });
      await expect(repository.resolveProject(machine.machineId, "/work/foreign"))
        .resolves.toMatchObject({ projectId: foreign.projectId });

      const entryAliases = [
        { path: "/work/reconcile", normalizedPath: "/work/reconcile" },
        { path: "/work/reconcile-alias", normalizedPath: "/work/reconcile-alias" },
        { path: "/work/local-only", normalizedPath: "/work/local-only" },
      ];
      const replacementMutation = await repository.replaceProjectAliases({
        machineId: machine.machineId,
        expectedPriorProjectId: original.projectId,
        projectId: replacement.projectId,
        aliases: entryAliases,
      });
      expect(replacementMutation).toMatchObject({
        aliases: [{}, {}, {}],
        prior: [
          { projectId: original.projectId },
          { projectId: original.projectId },
          null,
        ],
      });
      for (const alias of entryAliases) {
        await expect(repository.resolveProject(machine.machineId, alias.normalizedPath))
          .resolves.toMatchObject({ projectId: replacement.projectId });
      }
      await expect(repository.unlinkProjectAliasIfOwned(
        machine.machineId,
        "/work/local-only",
        replacement.projectId,
      )).resolves.toMatchObject({
        projectId: replacement.projectId,
        alias: { normalizedPath: "/work/local-only" },
      });
      const removed = await repository.unlinkProjectAliasesIfOwned(
        machine.machineId,
        replacement.projectId,
        entryAliases,
      );
      expect(removed).toHaveLength(2);
      await expect(repository.resolveProject(machine.machineId, "/work/sibling-entry"))
        .resolves.toMatchObject({ projectId: original.projectId });
      await expect(repository.restoreProjectAliases(
        machine.machineId,
        replacement.projectId,
        removed!,
      )).resolves.toBe(true);
      for (const alias of entryAliases.slice(0, 2)) {
        await expect(repository.resolveProject(machine.machineId, alias.normalizedPath))
          .resolves.toMatchObject({ projectId: replacement.projectId });
      }
      await expect(repository.resolveProject(machine.machineId, "/work/local-only"))
        .resolves.toBeNull();

      const disposable = await repository.createProject({
        machineId: machine.machineId,
        displayName: "Disposable",
        path: "/work/disposable",
        normalizedPath: "/work/disposable",
      });
      await expect(repository.cleanupCreatedProject(
        machine.machineId,
        disposable.projectId,
        ["/work/disposable"],
      )).resolves.toBe(true);
      await expect(repository.resolveProject(machine.machineId, "/work/disposable"))
        .resolves.toBeNull();
      expect((await repository.listProjects()).map(({ projectId }) => projectId))
        .not.toContain(disposable.projectId);
    });
  });

  it("does not bind a concurrent project after an ambiguous create rolls back", async () => {
    await withPostgreSqlTestDatabase("identity-create-race", async (database) => {
      await grantIdentityRuntimePrivileges(database);
      const repository = new PostgreSqlIdentityRepository(database.runtime);
      const machine = await repository.registerMachine(
        `machine:${"f".repeat(64)}`,
        "Machine F",
      );
      let candidateId: string | undefined;
      const rollbackExecutor = {
        query: database.runtime.query.bind(database.runtime),
        transaction: async <T>(
          callback: Parameters<PostgreSqlIdentityExecutor["transaction"]>[0],
          options: Parameters<PostgreSqlIdentityExecutor["transaction"]>[1],
        ): Promise<T> => {
          try {
            await database.runtime.transaction(async (transaction) => {
              const candidate = await callback(transaction);
              candidateId = (candidate as { projectId: string }).projectId;
              throw new Error("force candidate rollback");
            }, options);
          } catch {
            // The candidate transaction is intentionally rolled back.
          }
          throw new PostgreSqlCommitOutcomeUnknownError(options);
        },
      } as PostgreSqlIdentityExecutor;
      const uncertain = new PostgreSqlIdentityRepository(rollbackExecutor);
      const home = mkdtempSync(join(tmpdir(), "lcm-pg-create-race-"));
      const projectPath = join(home, "project");
      mkdirSync(projectPath);
      const originalHome = process.env.HOME;
      const originalUserProfile = process.env.USERPROFILE;
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      clearProjectMapCache();
      recoverMachineIdentity({
        version: 1,
        identityKey: machine.identityKey,
        machineId: machine.machineId,
        displayName: machine.displayName,
      }, { homeDir: home });
      const config: ResolvedStorageConfig = {
        backend: "postgresql",
        postgresql: {
          url: "postgresql://unused",
          caFile: "/unused",
          poolMax: 1,
          connectionTimeoutMs: 1,
          idleTimeoutMs: 1,
          statementTimeoutMs: 1,
        },
      };
      const facade: IdentityRepository = {
        registerMachine: repository.registerMachine.bind(repository),
        recoverMachine: repository.recoverMachine.bind(repository),
        createProject: async (input) => {
          try {
            return await uncertain.createProject(input);
          } catch (error) {
            expect(error).toBeInstanceOf(PostgreSqlIdentityCreateOutcomeUnknownError);
            await repository.createProject({
              ...input,
              displayName: "Concurrent owner",
            });
            throw error;
          }
        },
        linkProject: repository.linkProject.bind(repository),
        replaceProjectAlias: repository.replaceProjectAlias.bind(repository),
        replaceProjectAliases: repository.replaceProjectAliases.bind(repository),
        unlinkPath: repository.unlinkPath.bind(repository),
        unlinkProjectAliasIfOwned: repository.unlinkProjectAliasIfOwned.bind(repository),
        unlinkProjectAliasesIfOwned: repository.unlinkProjectAliasesIfOwned.bind(repository),
        unlinkProject: repository.unlinkProject.bind(repository),
        deleteProjectIfUnreferenced: repository.deleteProjectIfUnreferenced.bind(repository),
        cleanupCreatedProject: repository.cleanupCreatedProject.bind(repository),
        restoreProjectAlias: repository.restoreProjectAlias.bind(repository),
        restoreProjectAliases: repository.restoreProjectAliases.bind(repository),
        restoreProjectAliasBatch: repository.restoreProjectAliasBatch.bind(repository),
        resolveProjectAliasesByPath: repository.resolveProjectAliasesByPath.bind(repository),
        resolveProject: repository.resolveProject.bind(repository),
        listProjects: repository.listProjects.bind(repository),
      };
      try {
        await expect(createIdentityProject(config, projectPath, {}, {
          homeDir: home,
          openSession: async () => ({
            repository: facade,
            close: async () => undefined,
          }),
        })).rejects.toMatchObject({
          message: expect.stringContaining("does not own"),
        });
        const owner = await repository.resolveProject(machine.machineId, projectPath);
        expect(owner?.projectId).toBeDefined();
        expect(owner?.projectId).not.toBe(candidateId);
        expect(resolveProjectIdentity(projectPath).remoteProjectId).toBeUndefined();
      } finally {
        clearProjectMapCache();
        rmSync(home, { recursive: true, force: true });
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        if (originalUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = originalUserProfile;
      }
    });
  });
});
