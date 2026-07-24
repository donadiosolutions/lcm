import { beforeAll, describe, expect, it } from "vitest";
import {
  PostgreSqlIdentityConflictError,
  PostgreSqlIdentityRepository,
} from "../../src/storage/postgresql/identity-repository.js";
import { assertHarnessReady, withPostgreSqlTestDatabase } from "./harness.js";

beforeAll(assertHarnessReady);

describe("PostgreSQL 18 machine and project identities", () => {
  it("converges concurrent machine upserts and lets two machines share one project", async () => {
    await withPostgreSqlTestDatabase("identity-share", async (database) => {
      const repository = new PostgreSqlIdentityRepository(database.migrator);
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
      const repository = new PostgreSqlIdentityRepository(database.migrator);
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
      const repository = new PostgreSqlIdentityRepository(database.migrator);
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
});
