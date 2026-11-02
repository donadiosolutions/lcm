import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { closeLcmConnection } from "../../src/db/connection.js";
import { performMigrationActivateCommand } from "../../src/migration/cli-activate.js";
import { performMigrationApply } from "../../src/migration/cli-apply.js";
import { performMigrationPlan } from "../../src/migration/cli-plan.js";
import { resolveMigrationPreflight } from "../../src/migration/cli-preflight.js";
import { performMigrationVerifyCommand } from "../../src/migration/cli-verify.js";
import { prepareSqliteMigrationEnrollment } from "../../src/migration/maintenance.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { resolveProjectIdentity } from "../../src/project-map.js";
import { configPath } from "../../src/runtime-paths.js";
import type { PostgreSqlConnectionSettings } from "../../src/storage/postgresql/contracts.js";
import {
  verifyPostgreSqlRuntimeSchema,
} from "../../src/storage/postgresql/runtime-readiness.js";
import { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";
import {
  assertHarnessReady,
  settings,
  withPostgreSqlTestDatabase,
} from "./harness.js";
import {
  applyManagedRuntimeGrants,
  assertManagedFunctionAclShape,
  revokeManagedTransferProfile,
  withManagedProviderDatabase,
  type ManagedProviderDatabase,
} from "./managed-provider-fixture.js";
import {
  dropActivationRole,
  DAEMON_PORT,
  grantRuntimeActivationRole,
  provisionActivationRole,
  RUNTIME_ROLE,
  TRANSFER_ROLE,
} from "./migration-activation-fixture.js";

beforeAll(assertHarnessReady);

const EXPECTED_OWNER = "lcm_test_migrator";

function presentPresence() {
  return {
    status: "present" as const,
    storageBackend: "sqlite",
    pid: 1,
    daemonInstanceId: "managed-provider-grants",
  };
}

async function prepareMigrationSource(
  home: string,
  transfer: PostgreSqlConnectionSettings,
): Promise<string> {
  const cwd = join(home, "project");
  mkdirSync(cwd, { mode: 0o700 });
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });

  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const local = resolveProjectIdentity(cwd);
  vi.unstubAllEnvs();

  const projectDir = join(home, ".lcm", "projects", local.id);
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, ".lcm", "events"), { mode: 0o700 });
  writeFileSync(join(projectDir, "meta.json"), `${JSON.stringify({ cwd })}\n`, { mode: 0o600 });
  await prepareSqliteMigrationEnrollment({
    cwd,
    homeDir: home,
    targetConfig: {
      backend: "postgresql",
      postgresql: { ...transfer, migrationRole: EXPECTED_OWNER },
    },
  });
  writeFileSync(configPath(home), `${JSON.stringify({
    daemon: { port: DAEMON_PORT },
    storage: {
      backend: "sqlite",
      postgresql: {
        migrationRole: EXPECTED_OWNER,
        poolMax: transfer.poolMax,
        connectionTimeoutMs: transfer.connectionTimeoutMs,
        idleTimeoutMs: transfer.idleTimeoutMs,
        statementTimeoutMs: transfer.statementTimeoutMs,
      },
    },
  })}\n`, { mode: 0o600 });
  return cwd;
}

function throwOnRefusal(step: string, outcome: { status: string }): void {
  if (outcome.status === "refuse") {
    throw new Error(`managed provider composed flow ${step} refused: ${JSON.stringify(outcome)}`);
  }
}

describe("managed-provider function grants", () => {
  it("completes plan, apply, verify, activate, transfer revocation, and runtime readiness with explicit default ACLs", async () => {
    await withManagedProviderDatabase("managed-flow", "explicit", async (fixture) => {
      const home = mkdtempSync(join(tmpdir(), "managed-provider-flow-"));
      const cwd = await prepareMigrationSource(home, fixture.transfer);
      try {
        await assertManagedFunctionAclShape(fixture);
        vi.stubEnv("LCM_POSTGRES_URL", fixture.transfer.url);
        vi.stubEnv("LCM_POSTGRES_CA_FILE", fixture.transfer.caFile);
        const preflight = () => resolveMigrationPreflight({
          cwd,
          homeDir: home,
          _operationsForTesting: { classifyPresence: async () => presentPresence() },
        });

        const plan = await performMigrationPlan({ cwd, homeDir: home, _preflight: preflight });
        throwOnRefusal("plan", plan);
        expect(plan.status).toBe("ok");
        if (plan.status !== "ok") throw new Error("managed plan did not return a generation");

        const apply = await performMigrationApply({
          cwd,
          homeDir: home,
          confirmGenerationId: plan.generationId,
          _preflight: preflight,
        });
        throwOnRefusal("apply", apply);
        expect(apply).toMatchObject({ status: "ok", applied: true, phase: "copied" });

        const common = {
          cwd,
          homeDir: home,
          generation: plan.generationId,
          confirmGenerationId: plan.generationId,
        };
        const verify = await performMigrationVerifyCommand(common);
        throwOnRefusal("verify", verify);
        expect(verify).toMatchObject({ status: "ok", applied: true, manifestPhase: "verified" });
        expect(new MigrationManifestStore({ homeDir: home }).read(plan.generationId).phase)
          .toBe("verified");

        await applyManagedRuntimeGrants(fixture, "runtime");
        await assertManagedFunctionAclShape(fixture);
        vi.stubEnv("LCM_POSTGRES_RUNTIME_URL", fixture.runtime.url);
        const activate = await performMigrationActivateCommand({
          ...common,
          confirmBackend: "postgresql",
        });
        throwOnRefusal("activate", activate);
        expect(activate).toMatchObject({ status: "ok", applied: true, manifestPhase: "active" });

        await revokeManagedTransferProfile(fixture);
        const runtime = new PostgreSqlRuntime(fixture.runtime);
        try {
          await expect(verifyPostgreSqlRuntimeSchema(runtime, {
            expectedOwner: EXPECTED_OWNER,
          })).resolves.toMatchObject({ runtimeRole: fixture.runtimeName });
        } finally {
          await runtime.close();
        }
      } finally {
        closeLcmConnection();
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
      }
    });
  }, 300_000);

  it("accepts NULL default ACLs through target reachability and runtime readiness with and without a peer", async () => {
    await withManagedProviderDatabase("managed-null", "null", async (fixture) => {
      await assertManagedFunctionAclShape(fixture);
      const transferReachability = await import("../../src/migration/target-reachability.js");
      await expect(transferReachability.verifyMigrationTargetReachability({
        settings: fixture.transfer,
        expectedOwner: EXPECTED_OWNER,
      })).resolves.toEqual({ status: "verified" });

      await applyManagedRuntimeGrants(fixture, "runtime");
      await assertManagedFunctionAclShape(fixture);
      const runtime = new PostgreSqlRuntime(fixture.runtime);
      try {
        await expect(verifyPostgreSqlRuntimeSchema(runtime, {
          expectedOwner: EXPECTED_OWNER,
          admittedPeer: { role: fixture.transferName },
        })).resolves.toMatchObject({ runtimeRole: fixture.runtimeName });
        await revokeManagedTransferProfile(fixture);
        await expect(verifyPostgreSqlRuntimeSchema(runtime, {
          expectedOwner: EXPECTED_OWNER,
        })).resolves.toMatchObject({ runtimeRole: fixture.runtimeName });
      } finally {
        await runtime.close();
      }
    });
  }, 120_000);

  async function expectManagedAclRefusal(
    label: string,
    mutate: (
      fixture: ManagedProviderDatabase,
      administrator: PostgreSqlRuntime,
    ) => Promise<void>,
    options: Readonly<{ exactAcl?: boolean }> = {},
  ): Promise<void> {
    await withManagedProviderDatabase(label, "explicit", async (fixture) => {
      await applyManagedRuntimeGrants(fixture, "runtime");
      const administrator = new PostgreSqlRuntime(settings(fixture.database.adminUrl));
      const runtime = new PostgreSqlRuntime(fixture.runtime);
      try {
        await mutate(fixture, administrator);
        const failure = await verifyPostgreSqlRuntimeSchema(runtime, {
          expectedOwner: EXPECTED_OWNER,
          admittedPeer: { role: fixture.transferName },
        }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        if (options.exactAcl !== false) {
          expect(failure).toMatchObject({
            reason: "acl-shape",
            operation: "inspectFunctionAcl",
          });
        }
      } finally {
        await Promise.allSettled([administrator.close(), runtime.close()]);
      }
    });
  }

  it("rejects a managed function when PUBLIC EXECUTE is missing", async () => {
    await expectManagedAclRefusal("managed-no-public", async (_fixture, administrator) => {
      await administrator.query({
        text: "REVOKE EXECUTE ON FUNCTION public.similarity(text, text) FROM PUBLIC",
      }, { domain: "factory", operation: "revokeManagedPublicExecute" });
    });
  });

  it("rejects a missing peer grant without PUBLIC even when the primary grant is explicit", async () => {
    await expectManagedAclRefusal("managed-peer-no-public", async (fixture, administrator) => {
      await administrator.query({
        text: `GRANT EXECUTE ON FUNCTION public.similarity(text, text) TO ${fixture.runtimeName};
               REVOKE EXECUTE ON FUNCTION public.similarity(text, text) FROM PUBLIC`,
      }, { domain: "factory", operation: "prepareManagedPeerMissingPublic" });
    });
  });

  it("rejects an extra managed-function grantee", async () => {
    await expectManagedAclRefusal("managed-extra", async (fixture, administrator) => {
      await administrator.query({
        text: `GRANT EXECUTE ON FUNCTION public.similarity(text, text) TO ${fixture.adminName}`,
      }, { domain: "factory", operation: "grantManagedExtraFunctionGrantee" });
    });
  });

  it("rejects grantable runtime EXECUTE on a managed function", async () => {
    await expectManagedAclRefusal("managed-grantable", async (fixture, administrator) => {
      await administrator.query({
        text: `GRANT EXECUTE ON FUNCTION public.similarity(text, text) TO ${fixture.runtimeName} WITH GRANT OPTION`,
      }, { domain: "factory", operation: "grantManagedGrantableFunction" });
    });
  });

  it("rejects a runtime EXECUTE grant from a foreign grantor", async () => {
    await expectManagedAclRefusal("managed-foreign", async (fixture, administrator) => {
      await administrator.query({
        text: `GRANT EXECUTE ON FUNCTION public.similarity(text, text) TO ${fixture.adminName} WITH GRANT OPTION`,
      }, { domain: "factory", operation: "grantManagedForeignGrantOption" });
      await fixture.admin.query({
        text: `GRANT EXECUTE ON FUNCTION public.similarity(text, text) TO ${fixture.runtimeName}`,
      }, { domain: "factory", operation: "grantManagedForeignFunctionGrant" });
    });
  });

  it("rejects an ordinary LCM function that replaces its explicit runtime grant with PUBLIC", async () => {
    await expectManagedAclRefusal("managed-lcm-public", async (fixture) => {
      await fixture.admin.query({
        text: `REVOKE EXECUTE ON FUNCTION lcm.normalize_search_text(text) FROM ${fixture.runtimeName};
               GRANT EXECUTE ON FUNCTION lcm.normalize_search_text(text) TO PUBLIC`,
      }, { domain: "factory", operation: "replaceManagedLcmFunctionGrant" });
    }, { exactAcl: false });
  });

  it("rejects a managed digest function without PUBLIC EXECUTE", async () => {
    await expectManagedAclRefusal("managed-digest-no-public", async (_fixture, administrator) => {
      await administrator.query({
        text: "REVOKE EXECUTE ON FUNCTION public.digest(text, text) FROM PUBLIC",
      }, { domain: "factory", operation: "revokeManagedDigestPublicExecute" });
    }, { exactAcl: false });
  });

  it("keeps explicit grants mandatory when the extension owner is the superuser", async () => {
    await withPostgreSqlTestDatabase("standard-owner", async (database) => {
      const roles = await provisionActivationRole(database);
      const administrator = new PostgreSqlRuntime(settings(database.adminUrl));
      const runtime = new PostgreSqlRuntime(roles.runtime);
      try {
        await grantRuntimeActivationRole(database, roles.transfer);
        await administrator.query({
          text: `REVOKE EXECUTE ON FUNCTION public.similarity(text, text)
                 FROM ${RUNTIME_ROLE}`,
        }, { domain: "factory", operation: "revokeStandardRuntimeFunctionGrant" });
        await expect(verifyPostgreSqlRuntimeSchema(runtime, {
          expectedOwner: EXPECTED_OWNER,
          admittedPeer: { role: TRANSFER_ROLE },
        })).rejects.toMatchObject({
          reason: "acl-shape",
          operation: "inspectFunctionAcl",
        });

        await administrator.query({
          text: `GRANT EXECUTE ON FUNCTION public.similarity(text, text) TO ${RUNTIME_ROLE};
                 REVOKE EXECUTE ON FUNCTION public.similarity(text, text) FROM ${TRANSFER_ROLE}`,
        }, { domain: "factory", operation: "revokeStandardPeerFunctionGrant" });
        await expect(verifyPostgreSqlRuntimeSchema(runtime, {
          expectedOwner: EXPECTED_OWNER,
          admittedPeer: { role: TRANSFER_ROLE },
        })).rejects.toMatchObject({
          reason: "acl-shape",
          operation: "inspectFunctionAcl",
        });
      } finally {
        await Promise.allSettled([administrator.close(), runtime.close()]);
        await dropActivationRole(database);
      }
    });
  });
});
