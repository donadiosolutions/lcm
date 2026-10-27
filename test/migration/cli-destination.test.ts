import { describe, expect, it, vi } from "vitest";
import { MachineIdentityFileError } from "../../src/machine-identity.js";
import { resolveMigrationDestination } from "../../src/migration/cli-destination.js";

const POSTGRESQL = {
  url: "postgresql://u:p@db/lcm", caFile: "/ca.pem", migrationRole: "lcm_migration",
  poolMax: 7, connectionTimeoutMs: 11, idleTimeoutMs: 12, statementTimeoutMs: 13, snapshotIdleTimeoutMs: 14,
};
const IDENTITY = {
  id: "0190aaaa-0000-7000-8000-000000000001", remoteProjectId: "0190aaaa-0000-7000-8000-000000000001",
  localProjectId: "a".repeat(64), machineId: "m-1", canonical: "/work/project", selectedPath: "/work/project",
};

const resolved = { status: "resolved" as const, config: { backend: "postgresql" as const, postgresql: POSTGRESQL } };

describe("resolveMigrationDestination (plan-v6.1 A-P1-1)", () => {
  it("resolves connectionSettings around the resolved storage.postgresql, its migration role, and the held-safe identity", async () => {
    const resolveIdentity = vi.fn(async () => ({ status: "resolved" as const, expectedIdentity: IDENTITY }));
    const result = await resolveMigrationDestination({
      cwd: "/work/project", homeDir: "/home/x",
      _operationsForTesting: {
        resolveTargetConfig: () => resolved,
        requireMachine: () => ({ machineId: "m-1" }) as never,
        resolveIdentity,
      },
    });
    expect(result).toEqual({
      status: "resolved",
      // The connection fields only: never the resolved object itself, never the migration role.
      settings: {
        url: POSTGRESQL.url, caFile: POSTGRESQL.caFile, poolMax: 7, connectionTimeoutMs: 11,
        idleTimeoutMs: 12, statementTimeoutMs: 13, snapshotIdleTimeoutMs: 14,
      },
      expectedOwner: "lcm_migration",
      expectedIdentity: IDENTITY,
    });
    // The identity is the held one: it never mints.
    expect(resolveIdentity).toHaveBeenCalledWith({
      preflight: { targetConfig: resolved.config, machineId: "m-1", candidate: { disposition: "continue-held" } },
      cwd: "/work/project", homeDir: "/home/x",
    });
  });

  it("passes a target refusal through with its evidence, and without it when there is none", async () => {
    const withEvidence = await resolveMigrationDestination({
      cwd: "/c", homeDir: "/h",
      _operationsForTesting: { resolveTargetConfig: () => ({ status: "refuse", reason: "migration-target-missing", evidence: "config-validation-error" }) },
    });
    expect(withEvidence).toEqual({ status: "refuse", reason: "migration-target-missing", evidence: "config-validation-error" });
    const bare = await resolveMigrationDestination({
      cwd: "/c", homeDir: "/h",
      _operationsForTesting: { resolveTargetConfig: () => ({ status: "refuse", reason: "migration-target-unresolvable" }) },
    });
    expect(bare).toEqual({ status: "refuse", reason: "migration-target-unresolvable" });
  });

  it("refuses an unregistered machine, and lets any other failure reach the boundary", async () => {
    const refusal = await resolveMigrationDestination({
      cwd: "/c", homeDir: "/h",
      _operationsForTesting: {
        resolveTargetConfig: () => resolved,
        requireMachine: () => { throw new MachineIdentityFileError("missing", "x"); },
      },
    });
    expect(refusal).toEqual({ status: "refuse", reason: "machine-identity-unregistered" });
    await expect(resolveMigrationDestination({
      cwd: "/c", homeDir: "/h",
      _operationsForTesting: { resolveTargetConfig: () => resolved, requireMachine: () => { throw new TypeError("boom"); } },
    })).rejects.toThrow("boom");
  });

  it("passes an identity refusal through with and without evidence", async () => {
    const base = { resolveTargetConfig: () => resolved, requireMachine: () => ({ machineId: "m-1" }) as never };
    expect(await resolveMigrationDestination({
      cwd: "/c", homeDir: "/h",
      _operationsForTesting: { ...base, resolveIdentity: async () => ({ status: "refuse", reason: "local-identity-unresolvable", evidence: "Error" }) },
    })).toEqual({ status: "refuse", reason: "local-identity-unresolvable", evidence: "Error" });
    expect(await resolveMigrationDestination({
      cwd: "/c", homeDir: "/h",
      _operationsForTesting: { ...base, resolveIdentity: async () => ({ status: "refuse", reason: "destination-project-absent" }) },
    })).toEqual({ status: "refuse", reason: "destination-project-absent" });
  });

  it("reads the real target configuration when none is injected (an empty home has none)", async () => {
    const result = await resolveMigrationDestination({ cwd: "/c", homeDir: "/nonexistent-lcm-home-for-test" });
    expect(result).toMatchObject({ status: "refuse", reason: "migration-target-missing" });
  });
});

