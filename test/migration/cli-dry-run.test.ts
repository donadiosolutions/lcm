import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { performMigrationDryRunCheck, migrationDryRunEvidence } from "../../src/migration/cli-dry-run.js";
import {
  prepareSqliteMigrationEnrollment,
  type SqliteMigrationEnrollmentInput,
} from "../../src/migration/maintenance.js";
import { localProjectIdentity } from "../../src/daemon/project.js";
import * as identityApi from "../../src/machine-identity.js";
import { closeLcmConnection } from "../../src/db/connection.js";
import { clearProjectMapCache } from "../../src/project-map.js";
import type { IdentityRepository } from "../../src/identity-service.js";

const roots: string[] = [];
const REGISTERED_MACHINE = "018f0b5d-1234-7abc-8def-1234567890ab";

afterEach(() => {
  closeLcmConnection();
  vi.restoreAllMocks();
  clearProjectMapCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-dry-run-cli-"));
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  roots.push(value);
  return value;
}

async function enrolled() {
  const homeDir = home();
  const cwd = join(homeDir, "project");
  mkdirSync(cwd, { mode: 0o700 });
  const local = localProjectIdentity(cwd, homeDir);
  const projectDir = join(homeDir, ".lcm", "projects", local.id);
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(homeDir, ".lcm", "events"), { mode: 0o700 });
  writeFileSync(join(projectDir, "meta.json"), `${JSON.stringify({ cwd })}\n`, { mode: 0o600 });
  const request: SqliteMigrationEnrollmentInput = {
    cwd,
    homeDir,
    targetConfig: {
      backend: "postgresql",
      postgresql: {
        url: "postgresql://unused.invalid/lcm",
        caFile: "/unused",
        migrationRole: "unused",
        poolMax: 1,
        connectionTimeoutMs: 100,
        idleTimeoutMs: 100,
        statementTimeoutMs: 100,
      },
    },
  };
  const registered = () => {
    const pending = identityApi.readMachineIdentity(homeDir)!;
    return { machineId: REGISTERED_MACHINE, identityKey: pending.identityKey, displayName: pending.displayName };
  };
  const repository = {
    registerMachine: vi.fn(async () => registered()),
    recoverMachine: vi.fn(async () => registered()),
  };
  const close = vi.fn(async () => undefined);
  const openIdentitySession = vi.fn(async () => ({ repository: repository as unknown as IdentityRepository, close }));
  await prepareSqliteMigrationEnrollment(request, { openIdentitySession });
  return { homeDir, cwd };
}

describe("performMigrationDryRunCheck (section 3: owns dryRunAuthenticatedSqliteMigrationSource, nothing else)", () => {
  it("succeeds for real against a real enrolled project, with no generation resolution, occupancy probe, or journal touched", async () => {
    const fixture = await enrolled();
    const result = await performMigrationDryRunCheck({ cwd: fixture.cwd, homeDir: fixture.homeDir });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.dryRun.roles.length).toBeGreaterThan(0);
    const evidence = migrationDryRunEvidence(result.dryRun);
    expect(Object.keys(evidence).sort()).toEqual(
      ["checksumSha256", "inspectedAt", "roleCount", "sourceByteWitnessSha256", "sourceSelectionSha256"].sort(),
    );
    expect(evidence.roleCount).toBe(result.dryRun.roles.length);
    expect(evidence.checksumSha256).toBe(result.dryRun.checksumSha256);
  });

  it("converts a real SqliteSnapshotError (unsupported-platform, via the lower-level function's own injection seam) into a dry-run-failed refusal carrying its reason", async () => {
    const fixture = await enrolled();
    const result = await performMigrationDryRunCheck({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        dryRun: (cwd, homeDir) =>
          import("../../src/migration/maintenance.js").then((mod) =>
            mod.dryRunAuthenticatedSqliteMigrationSource(cwd, homeDir, {
              _operationsForTesting: { getuid: () => Number.NaN, observe: () => undefined },
            }),
          ),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "dry-run-failed", evidence: "unsupported-platform" });
  });

  it("converts a non-SqliteSnapshotError throw into a dry-run-failed refusal carrying the error's name", async () => {
    const fixture = await enrolled();
    const result = await performMigrationDryRunCheck({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        dryRun: async () => { throw new RangeError("an unrelated failure"); },
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "dry-run-failed", evidence: "RangeError" });
  });

  it("converts an unknown Error into dry-run-failed carrying only its name: dry-run's own catch is its boundary (round-1 B-4)", async () => {
    const result = await performMigrationDryRunCheck({
      cwd: "/tmp/project", homeDir: "/tmp/home",
      _operationsForTesting: { dryRun: async () => { throw new TypeError("a message with /a/path"); } },
    });
    expect(result).toEqual({ status: "refuse", reason: "dry-run-failed", evidence: "TypeError" });
  });

  it("converts a non-Error throw into a dry-run-failed refusal with unknown-dry-run-failure evidence", async () => {
    const fixture = await enrolled();
    const result = await performMigrationDryRunCheck({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        dryRun: async () => { throw "not-an-error-object"; },
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "dry-run-failed", evidence: "unknown-dry-run-failure" });
  });
});
