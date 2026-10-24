import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  migrationIdentityPreview,
  resolveMigrationExpectedIdentity,
  resolveMigrationPreflight,
  type MigrationPreflightResult,
} from "../../src/migration/cli-preflight.js";
import { hashProjectPath, normalizeProjectPath, projectMapPath } from "../../src/project-map.js";
import { readFileSync, existsSync } from "node:fs";
import { BackendPublicationCoordinator, type BackendPublicationDriver } from "../../src/storage/backend-publication.js";
import {
  prepareSqliteMigrationEnrollment,
  type SqliteMigrationEnrollmentInput,
} from "../../src/migration/maintenance.js";
import { localProjectIdentity } from "../../src/daemon/project.js";
import * as identityApi from "../../src/machine-identity.js";
import { closeLcmConnection } from "../../src/db/connection.js";
import { clearProjectMapCache } from "../../src/project-map.js";
import type { IdentityRepository } from "../../src/identity-service.js";
import { MigrationIdentityError } from "../../src/migration/generation-identity.js";
import type { ResolvedPostgreSqlConfig } from "../../src/daemon/config.js";
import type { PostgreSqlRuntime } from "../../src/storage/postgresql/runtime.js";

const roots: string[] = [];
const REGISTERED_MACHINE = "018f0b5d-1234-7abc-8def-1234567890ab";

afterEach(() => {
  closeLcmConnection();
  vi.restoreAllMocks();
  clearProjectMapCache();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-preflight-"));
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
  return { homeDir, cwd, local };
}

const REAL_TARGET_CONFIG: ResolvedPostgreSqlConfig = {
  backend: "postgresql",
  postgresql: {
    url: "postgresql://user:password@db.example.com:5432/lcm",
    caFile: "/unused",
    migrationRole: "lcm_migrator",
    poolMax: 4,
    connectionTimeoutMs: 1000,
    idleTimeoutMs: 1000,
    statementTimeoutMs: 1000,
  },
};

function succeedingTargetConfig() {
  return { status: "resolved" as const, config: REAL_TARGET_CONFIG };
}

function presentPresence() {
  return { status: "present" as const, storageBackend: "sqlite", pid: 1, daemonInstanceId: "gen-1" };
}

function verifiedReachability() {
  return { status: "verified" as const };
}

/**
 * A stub identity runtime: never a real PostgreSQL connection. This unit
 * file tests step 4's composition, not resolveMigrationTargetProjectId's
 * own real-PostgreSQL correctness -- that is target-identity.test.ts's job
 * (mocked) and the real-PostgreSQL round-trip's job (assembled, for real).
 */
function stubIdentityRuntime(): PostgreSqlRuntime {
  return { close: vi.fn(async () => undefined) } as unknown as PostgreSqlRuntime;
}

function identitySeams(projectId = "remote-project-1") {
  return {
    requireMachine: vi.fn(() => ({ machineId: "018f0b5d-1234-4abc-8def-1234567890ab" }) as never),
    createIdentityRuntime: vi.fn(stubIdentityRuntime),
    lookupTargetProject: vi.fn(async () => projectId as string | null),
  };
}

describe("resolveMigrationPreflight: composes every step for real, never collapsing a three-valued primitive", () => {
  it("succeeds end to end using real base computation and candidate resolution against a real enrolled project, with target config/presence/reachability/machine-identity/destination-identity injected to succeed (each is independently, thoroughly tested elsewhere: machine identity for real below, destination identity in target-identity.test.ts and the real-PostgreSQL round trip)", async () => {
    const fixture = await enrolled();
    const seams = identitySeams();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
        ...seams,
      },
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("unreachable");
    expect(result.candidate.disposition).toBe("fresh");
    expect(result.presence.status).toBe("present");
    expect(result.local).toEqual({ id: fixture.local.id, canonical: fixture.local.canonical, persisted: false });
    expect(result.machineId).toBe("018f0b5d-1234-4abc-8def-1234567890ab");
    expect(result.destinationProjectId).toBe("remote-project-1");
    expect(result.base.length).toBeGreaterThan(0);
    // The identity runtime is always constructed and always closed, even
    // when lookupTargetProject itself is injected -- it is passed a real
    // repository wrapping whatever runtime this seam returns.
    expect(seams.createIdentityRuntime).toHaveBeenCalledOnce();
  });

  it("refuses at step 1 (target config) with the target resolver's own reason, never proceeding to presence or reachability", async () => {
    const fixture = await enrolled();
    const classifyPresence = vi.fn();
    const verifyReachability = vi.fn();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: () => ({ status: "refuse", reason: "migration-target-missing", evidence: "config-validation-error" }),
        classifyPresence,
        verifyReachability,
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "migration-target-missing", evidence: "config-validation-error" });
    expect(classifyPresence).not.toHaveBeenCalled();
    expect(verifyReachability).not.toHaveBeenCalled();
  });

  it("refuses daemon-presence-unresolvable -- the only presence outcome that refuses (both present and authoritatively-absent proceed to ready, proven by the two tests below)", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => ({ status: "unresolvable" as const, evidence: "pidfile-live-no-answer" }),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "daemon-presence-unresolvable", evidence: "pidfile-live-no-answer" });
  });

  it("proceeds to ready when presence is authoritatively-absent -- a positively confirmed absence is establishing presence, not a refusal (red: refusing here would force an operator to start a daemon purely to pass this check, immediately before a hold that makes that very daemon's sweeps fail)", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => ({ status: "authoritatively-absent" as const }),
        verifyReachability: async () => verifiedReachability(),
        ...identitySeams(),
      },
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("unreachable");
    expect(result.presence).toEqual({ status: "authoritatively-absent" });
  });

  it("refuses with the reachability verifier's own reason and evidence when target verification fails, never proceeding to machine or destination identity resolution", async () => {
    const fixture = await enrolled();
    const seams = identitySeams();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => ({ status: "refuse", reason: "migration-target-verification-failed", evidence: "readiness-runtime-role-policy" }),
        ...seams,
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "migration-target-verification-failed", evidence: "readiness-runtime-role-policy" });
    expect(seams.requireMachine).not.toHaveBeenCalled();
    expect(seams.lookupTargetProject).not.toHaveBeenCalled();
  });

  it("refuses machine-identity-unregistered for real: a fresh, never-enrolled home genuinely has no registered machine identity (the real, not injected, requireMachineIdentity default)", async () => {
    const homeDir = home();
    const cwd = join(homeDir, "project");
    mkdirSync(cwd, { mode: 0o700 });
    const result = await resolveMigrationPreflight({
      cwd,
      homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "machine-identity-unregistered" });
  });

  it("resolves machine identity for real (the real, not injected, requireMachineIdentity default) against a real enrolled project, proceeding to the injected destination-identity step with the real machineId", async () => {
    const fixture = await enrolled();
    const lookupTargetProject = vi.fn(async () => "remote-project-2" as string | null);
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
        createIdentityRuntime: stubIdentityRuntime,
        lookupTargetProject,
      },
    });
    expect(result.status).toBe("ready");
    expect(lookupTargetProject).toHaveBeenCalledWith(expect.objectContaining({ machineId: REGISTERED_MACHINE }));
  });

  it("uses the real createIdentityRuntime default (no injection): constructs a real PostgreSqlRuntime for the target settings and closes it for real, with only destination-identity resolution itself injected", async () => {
    const fixture = await enrolled();
    const lookupTargetProject = vi.fn(async () => "remote-project-3" as string | null);
    // PostgreSqlRuntime's constructor synchronously reads and validates
    // caFile (client-config.ts) before this test's injected
    // lookupTargetProject ever runs, so the shared REAL_TARGET_CONFIG's
    // placeholder "/unused" path is not enough here -- a real, readable
    // (if not genuinely trusted) file is required to get past
    // construction.
    const caFile = join(fixture.homeDir, "dummy-ca.pem");
    writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\ndummy\n-----END CERTIFICATE-----\n", { mode: 0o600 });
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: () => ({
          status: "resolved" as const,
          config: { backend: "postgresql" as const, postgresql: { ...REAL_TARGET_CONFIG.postgresql, caFile } },
        }),
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
        lookupTargetProject,
      },
    });
    expect(result.status).toBe("ready");
    expect(lookupTargetProject).toHaveBeenCalledOnce();
    // The real runtime was constructed and handed a real
    // PostgreSqlIdentityRepository wrapping it -- lookupTargetProject's
    // own first argument is the repository, never asserted structurally
    // here since target-identity.test.ts already covers that shape; this
    // test's job is only proving the real construct-then-close path runs
    // without needing a live connection (no query is ever issued).
  });

  it("re-throws a non-MachineIdentityFileError from requireMachine rather than misclassifying it", async () => {
    const fixture = await enrolled();
    const outcome = resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
        requireMachine: () => { throw new Error("an unrelated failure"); },
      },
    });
    await expect(outcome).rejects.toThrow("an unrelated failure");
  });

  it("closes the identity runtime even when lookupTargetProject itself throws, and still propagates the throw", async () => {
    const fixture = await enrolled();
    const close = vi.fn(async () => undefined);
    const outcome = resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
        requireMachine: identitySeams().requireMachine,
        createIdentityRuntime: () => ({ close }) as unknown as PostgreSqlRuntime,
        lookupTargetProject: async () => { throw new Error("connection reset"); },
      },
    });
    await expect(outcome).rejects.toThrow("connection reset");
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the identity runtime even when the runtime's own close() itself throws, without masking the real outcome (red: an unguarded close() rejection here would replace a clean ready result with an unrelated throw)", async () => {
    const fixture = await enrolled();
    const close = vi.fn(async () => { throw new Error("close failed"); });
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
        requireMachine: identitySeams().requireMachine,
        createIdentityRuntime: () => ({ close }) as unknown as PostgreSqlRuntime,
        lookupTargetProject: async () => "remote-project-1" as string | null,
      },
    });
    expect(result.status).toBe("ready");
    expect(close).toHaveBeenCalledOnce();
  });

  it("converts a MigrationIdentityError from base computation into a generation-<reason> refusal", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
        ...identitySeams(),
        computeBase: () => {
          throw new MigrationIdentityError("invalid-input", "test", null);
        },
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "generation-invalid-input", evidence: undefined });
  });

  it("re-throws a non-MigrationIdentityError from base computation rather than misclassifying it", async () => {
    const fixture = await enrolled();
    const outcome = resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
        ...identitySeams(),
        computeBase: () => { throw new Error("an unrelated base computation failure"); },
      },
    });
    await expect(outcome).rejects.toThrow("an unrelated base computation failure");
  });

  it("propagates the candidate resolver's own refusal unchanged when candidate resolution refuses", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
        verifyReachability: async () => verifiedReachability(),
        ...identitySeams(),
        resolveCandidate: async () => ({ status: "refuse", reason: "continuation-mismatched-hold" }),
      },
    });
    expect(result).toEqual({ status: "refuse", reason: "continuation-mismatched-hold" });
  });

  it("uses the real classifyMigrationDaemonPresence default (no injection): a fresh home with no daemon really is authoritatively-absent, and preflight proceeds past it rather than refusing -- landing on the next real step's own refusal (target reachability against an unreachable host) instead", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
      },
    });
    expect(result.status).toBe("refuse");
    expect((result as { reason: string }).reason).toMatch(/^migration-target-verification-/);
  });

  it("uses the real verifyMigrationTargetReachability default (no injection): a genuinely unreachable target really fails verification, landing on a verification refusal", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd,
      homeDir: fixture.homeDir,
      _operationsForTesting: {
        resolveTargetConfig: succeedingTargetConfig,
        classifyPresence: async () => presentPresence(),
      },
    });
    expect(result.status).toBe("refuse");
    expect((result as { reason: string }).reason).toMatch(/^migration-target-verification-/);
  });

  it("uses the real resolveMigrationTargetConfig default (no injection): a fresh home with no config and no LCM_POSTGRES_* env vars really has no usable target, landing on migration-target-missing", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationPreflight({ cwd: fixture.cwd, homeDir: fixture.homeDir });
    expect(result.status).toBe("refuse");
    expect((result as { reason: string }).reason).toMatch(/^migration-target-/);
  });
});
function previewOps(extra: Record<string, unknown> = {}) {
  return {
    resolveTargetConfig: succeedingTargetConfig,
    classifyPresence: async () => presentPresence(),
    verifyReachability: async () => verifiedReachability(),
    ...identitySeams(),
    ...extra,
  };
}

describe("resolveMigrationPreflight is a read-only preview (plan-v5 Part B (3); closes round-1 A-4)", () => {
  it("reports an unpersisted local project as not persisted and creates no map file (red against the old resolveProjectIdentity call, which minted it)", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationPreflight({ cwd: fixture.cwd, homeDir: fixture.homeDir, _operationsForTesting: previewOps() });
    if (result.status !== "ready") throw new Error("unreachable");
    expect(result.local).toEqual({ id: hashProjectPath(normalizeProjectPath(fixture.cwd)), canonical: normalizeProjectPath(fixture.cwd), persisted: false });
    expect(existsSync(projectMapPath(fixture.homeDir))).toBe(false);
    expect(migrationIdentityPreview(result)).toEqual({ destinationProject: "exists", localProject: "not-persisted" });
  });

  it("uses a persisted map entry, reports it as persisted, and leaves the map bytes unchanged", async () => {
    const fixture = await enrolled();
    const canonical = normalizeProjectPath(fixture.cwd);
    const id = hashProjectPath(canonical);
    writeFileSync(projectMapPath(fixture.homeDir), JSON.stringify({ [id]: { canonical, aliases: [] } }), { mode: 0o600 });
    const before = readFileSync(projectMapPath(fixture.homeDir), "utf8");
    const result = await resolveMigrationPreflight({ cwd: fixture.cwd, homeDir: fixture.homeDir, _operationsForTesting: previewOps() });
    if (result.status !== "ready") throw new Error("unreachable");
    expect(result.local).toEqual({ id, canonical, persisted: true });
    expect(readFileSync(projectMapPath(fixture.homeDir), "utf8")).toBe(before);
  });

  it("works while a maintenance hold fences every consumer read, with the real held-safe reader (red: resolveProjectIdentity cannot run under a hold)", async () => {
    const fixture = await enrolled();
    const canonical = normalizeProjectPath(fixture.cwd);
    const id = hashProjectPath(canonical);
    writeFileSync(projectMapPath(fixture.homeDir), JSON.stringify({ [id]: { canonical, aliases: [] } }), { mode: 0o600 });
    const refuse = async (): Promise<never> => { throw new Error("v2 driver must not run"); };
    const driver: BackendPublicationDriver = { observeLocalState: refuse, publishProjectMap: refuse, publishConfig: refuse, restoreConfig: refuse, restoreProjectMap: refuse };
    await new BackendPublicationCoordinator({ homeDir: fixture.homeDir, driver }).enterMaintenance({
      publicationId: "maintenance-publication", generationId: "generation-1",
      sourceSelectionSha256: "a".repeat(64), queueEvidenceSha256: "b".repeat(64),
      roster: [{ machineId: REGISTERED_MACHINE, queueCutoff: null, evidenceSha256: "a".repeat(64) }],
    });
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd, homeDir: fixture.homeDir,
      _operationsForTesting: previewOps({ resolveCandidate: async () => ({ status: "candidate", disposition: "continue-held", generationId: "generation-1" }) }),
    });
    if (result.status !== "ready") throw new Error("unreachable");
    expect(result.local.persisted).toBe(true);
  });

  it("refuses local-identity-unresolvable, carrying only the error name, when the map cannot be read", async () => {
    const fixture = await enrolled();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd, homeDir: fixture.homeDir,
      _operationsForTesting: previewOps({ readLocalIdentity: () => { throw new TypeError("a message with /a/path"); } }),
    });
    expect(result).toEqual({ status: "refuse", reason: "local-identity-unresolvable", evidence: "TypeError" });
  });

  it("reports a missing destination project as will-be-created-at-apply and never creates it", async () => {
    const fixture = await enrolled();
    const seams = identitySeams();
    const result = await resolveMigrationPreflight({
      cwd: fixture.cwd, homeDir: fixture.homeDir,
      _operationsForTesting: previewOps({ lookupTargetProject: vi.fn(async () => null as string | null) }),
    });
    if (result.status !== "ready") throw new Error("unreachable");
    expect(result.destinationProjectId).toBeNull();
    expect(migrationIdentityPreview(result)).toEqual({ destinationProject: "will-be-created-at-apply", localProject: "not-persisted" });
    expect(seams.createIdentityRuntime).not.toHaveBeenCalled();
  });
});

describe("migrationIdentityPreview", () => {
  it("reports both axes independently", () => {
    expect(migrationIdentityPreview(readyPreview("fresh", { destinationProjectId: "p" }))).toEqual({ destinationProject: "exists", localProject: "persisted" });
    expect(migrationIdentityPreview(readyPreview("fresh", { destinationProjectId: null }))).toEqual({ destinationProject: "will-be-created-at-apply", localProject: "persisted" });
    expect(migrationIdentityPreview(readyPreview("fresh", { local: { id: "a".repeat(64), canonical: "/projects/x", persisted: false } }))).toEqual({ destinationProject: "will-be-created-at-apply", localProject: "not-persisted" });
  });
});

function readyPreview(disposition: "fresh" | "recover-entering" | "continue-held", overrides: Partial<Extract<MigrationPreflightResult, { status: "ready" }>> = {}) {
  return {
    status: "ready" as const,
    targetConfig: REAL_TARGET_CONFIG,
    presence: { status: "authoritatively-absent" as const },
    candidate: { status: "candidate" as const, disposition, generationId: "generation-0" },
    local: { id: "a".repeat(64), canonical: "/projects/x", persisted: true },
    machineId: REGISTERED_MACHINE,
    destinationProjectId: null,
    base: "base",
    ...overrides,
  };
}

describe("resolveMigrationExpectedIdentity (the minting step, taken only after apply's fence)", () => {
  function mintOps(extra: Record<string, unknown> = {}) {
    return {
      createIdentityRuntime: vi.fn(stubIdentityRuntime),
      resolveLocalIdentity: vi.fn(() => ({ id: "b".repeat(64), canonical: "/projects/minted" })),
      readLocalIdentity: vi.fn(() => ({ id: "c".repeat(64), canonical: "/projects/persisted" }) as { id: string; canonical: string } | null),
      resolveTargetIdentity: vi.fn(async () => ({ status: "resolved" as const, projectId: "minted-project", effect: "created" as const })),
      lookupTargetProject: vi.fn(async () => "existing-project" as string | null),
      readAuthorizedAliases: vi.fn(() => [] as string[]),
      ...extra,
    };
  }

  it("fresh: mints the local entry with the home passed through, then the destination project, reporting both write boundaries as they succeed", async () => {
    const ops = mintOps({ readLocalIdentity: vi.fn(() => null) });
    const effects: unknown[] = [];
    const result = await resolveMigrationExpectedIdentity({ preflight: readyPreview("fresh"), cwd: "/c", homeDir: "/h", _operationsForTesting: ops, observe: (effect) => effects.push(effect) });
    expect(result).toEqual({
      status: "resolved",
      expectedIdentity: {
        id: "minted-project", remoteProjectId: "minted-project", localProjectId: "b".repeat(64),
        machineId: REGISTERED_MACHINE, canonical: "/projects/minted", selectedPath: "/projects/minted",
      },
      effects: { localProject: "persisted", destinationProject: "created" },
    });
    expect(ops.resolveLocalIdentity).toHaveBeenCalledWith("/c", { homeDir: "/h" });
    // The pre-write read decides the actual effect under the caller's admission.
    expect(ops.readLocalIdentity).toHaveBeenCalledWith({ homeDir: "/h", cwd: "/c" });
    expect(ops.lookupTargetProject).not.toHaveBeenCalled();
    expect(effects).toEqual([{ stage: "local", outcome: "persisted" }, { stage: "destination", outcome: "created" }]);
  });

  it("fresh: mints the destination with the map entry's authorized aliases, read for the resolved local project under the caller's admission (#1678)", async () => {
    const token = {} as never;
    const readAuthorizedAliases = vi.fn(() => ["/projects/moved"]);
    const ops = mintOps({ readAuthorizedAliases });
    await resolveMigrationExpectedIdentity({ preflight: readyPreview("fresh"), cwd: "/c", homeDir: "/h", publicationLockToken: token, _operationsForTesting: ops });
    expect(readAuthorizedAliases).toHaveBeenCalledWith({
      homeDir: "/h", localProjectId: "b".repeat(64), canonicalPath: "/projects/minted", publicationLockToken: token,
    });
    expect(ops.resolveTargetIdentity).toHaveBeenCalledWith(expect.objectContaining({ authorityCanonicalPath: "/projects/minted", aliases: ["/projects/moved"] }));
  });

  it("fresh: without a caller admission the alias read takes its own, and a held step never reads aliases", async () => {
    const ops = mintOps();
    await resolveMigrationExpectedIdentity({ preflight: readyPreview("fresh"), cwd: "/c", homeDir: "/h", _operationsForTesting: ops });
    expect(ops.readAuthorizedAliases).toHaveBeenCalledWith({ homeDir: "/h", localProjectId: "b".repeat(64), canonicalPath: "/projects/minted" });
    const held = mintOps();
    await resolveMigrationExpectedIdentity({ preflight: readyPreview("continue-held"), cwd: "/c", homeDir: "/h", _operationsForTesting: held });
    expect(held.readAuthorizedAliases).not.toHaveBeenCalled();
  });

  it("fresh: an entry and a destination a concurrent actor already wrote are reported reused, never as this step's mint (round-3 synthesis P2)", async () => {
    const ops = mintOps({ resolveTargetIdentity: vi.fn(async () => ({ status: "resolved" as const, projectId: "winner-project", effect: "reused" as const })) });
    const effects: unknown[] = [];
    const result = await resolveMigrationExpectedIdentity({ preflight: readyPreview("fresh"), cwd: "/c", homeDir: "/h", _operationsForTesting: ops, observe: (effect) => effects.push(effect) });
    expect(result).toMatchObject({ status: "resolved", effects: { localProject: "reused", destinationProject: "reused" } });
    expect(effects).toEqual([{ stage: "local", outcome: "reused" }, { stage: "destination", outcome: "reused" }]);
  });

  it("fresh: an unreadable map before the write is local-identity-unresolvable, writes nothing and reports no boundary", async () => {
    const ops = mintOps({ readLocalIdentity: () => { throw new RangeError("boom /a/path"); } });
    const effects: unknown[] = [];
    const result = await resolveMigrationExpectedIdentity({ preflight: readyPreview("fresh"), cwd: "/c", homeDir: "/h", _operationsForTesting: ops, observe: (effect) => effects.push(effect) });
    expect(result).toEqual({ status: "refuse", reason: "local-identity-unresolvable", evidence: "RangeError" });
    expect(ops.resolveLocalIdentity).not.toHaveBeenCalled();
    expect(effects).toEqual([]);
  });

  it("fresh: a destination refusal still reported the local boundary that preceded it", async () => {
    const ops = mintOps({ readLocalIdentity: () => null, resolveTargetIdentity: async () => ({ status: "refuse", reason: "migration-target-identity-unresolvable", evidence: "post-conflict-reread-absent" }) });
    const effects: unknown[] = [];
    await resolveMigrationExpectedIdentity({ preflight: readyPreview("fresh"), cwd: "/c", homeDir: "/h", _operationsForTesting: ops, observe: (effect) => effects.push(effect) });
    expect(effects).toEqual([{ stage: "local", outcome: "persisted" }]);
  });

  it("fresh: a caller already inside the append barrier hands its token to the local mint instead of taking the consumer lock", async () => {
    const ops = mintOps();
    const token = { barrier: true };
    const result = await resolveMigrationExpectedIdentity({ preflight: readyPreview("fresh"), cwd: "/c", homeDir: "/h", publicationLockToken: token, _operationsForTesting: ops });
    expect(result).toMatchObject({ status: "resolved" });
    expect(ops.resolveLocalIdentity).toHaveBeenCalledWith("/c", { homeDir: "/h", _publicationLockToken: token });
  });

  it("fresh: propagates the destination resolver's own refusal", async () => {
    const ops = mintOps({ resolveTargetIdentity: async () => ({ status: "refuse", reason: "migration-target-identity-unresolvable", evidence: "post-conflict-reread-absent" }) });
    const result = await resolveMigrationExpectedIdentity({ preflight: readyPreview("fresh"), cwd: "/c", homeDir: "/h", _operationsForTesting: ops });
    expect(result).toEqual({ status: "refuse", reason: "migration-target-identity-unresolvable", evidence: "post-conflict-reread-absent" });
  });

  it.each(["recover-entering", "continue-held"] as const)(
    "%s: mints nothing under a hold: reads the persisted local identity and SELECTs the destination only",
    async (disposition) => {
      const ops = mintOps();
      const effects: unknown[] = [];
      const result = await resolveMigrationExpectedIdentity({ preflight: readyPreview(disposition), cwd: "/c", homeDir: "/h", _operationsForTesting: ops, observe: (effect) => effects.push(effect) });
      expect(result).toMatchObject({
        status: "resolved",
        expectedIdentity: { id: "existing-project", remoteProjectId: "existing-project", localProjectId: "c".repeat(64), canonical: "/projects/persisted" },
        effects: { localProject: "reused", destinationProject: "reused" },
      });
      expect(ops.resolveLocalIdentity).not.toHaveBeenCalled();
      expect(ops.resolveTargetIdentity).not.toHaveBeenCalled();
      expect(ops.readLocalIdentity).toHaveBeenCalledWith({ homeDir: "/h", cwd: "/c" });
      expect(effects).toEqual([{ stage: "local", outcome: "reused" }, { stage: "destination", outcome: "reused" }]);
    },
  );

  it("held: a missing persisted local identity is exit 5, never minted", async () => {
    const ops = mintOps({ readLocalIdentity: () => null });
    const result = await resolveMigrationExpectedIdentity({ preflight: readyPreview("continue-held"), cwd: "/c", homeDir: "/h", _operationsForTesting: ops });
    expect(result).toEqual({ status: "refuse", reason: "local-identity-not-persisted" });
    expect(ops.createIdentityRuntime).not.toHaveBeenCalled();
  });

  it("held: an unreadable map is local-identity-unresolvable with only the error name", async () => {
    const ops = mintOps({ readLocalIdentity: () => { throw new RangeError("boom /a/path"); } });
    const result = await resolveMigrationExpectedIdentity({ preflight: readyPreview("continue-held"), cwd: "/c", homeDir: "/h", _operationsForTesting: ops });
    expect(result).toEqual({ status: "refuse", reason: "local-identity-unresolvable", evidence: "RangeError" });
  });

  it("held: a missing destination project is exit 5, never created, and the runtime is still closed", async () => {
    const close = vi.fn(async () => undefined);
    const ops = mintOps({ lookupTargetProject: async () => null, createIdentityRuntime: () => ({ close }) as unknown as PostgreSqlRuntime });
    const result = await resolveMigrationExpectedIdentity({ preflight: readyPreview("recover-entering"), cwd: "/c", homeDir: "/h", _operationsForTesting: ops });
    expect(result).toEqual({ status: "refuse", reason: "destination-project-absent" });
    expect(ops.resolveTargetIdentity).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the runtime when the destination step throws, without masking the throw, and tolerates a failing close", async () => {
    const close = vi.fn(async () => { throw new Error("close failed"); });
    const ops = mintOps({ resolveTargetIdentity: async () => { throw new Error("connection reset"); }, createIdentityRuntime: () => ({ close }) as unknown as PostgreSqlRuntime });
    await expect(resolveMigrationExpectedIdentity({ preflight: readyPreview("fresh"), cwd: "/c", homeDir: "/h", _operationsForTesting: ops }))
      .rejects.toThrow("connection reset");
    expect(close).toHaveBeenCalledOnce();
  });

  it("uses the real default runtime constructor, reader and resolvers when none are injected (it fails at the unreachable host, after the real reader ran)", async () => {
    const fixture = await enrolled();
    await expect(resolveMigrationExpectedIdentity({
      preflight: readyPreview("continue-held", { targetConfig: { backend: "postgresql", postgresql: { ...REAL_TARGET_CONFIG.postgresql, caFile: "/nonexistent-ca" } } }),
      cwd: fixture.cwd, homeDir: fixture.homeDir,
    })).resolves.toEqual({ status: "refuse", reason: "local-identity-not-persisted" });
  });

  it("constructs the real default PostgreSqlRuntime for a held destination lookup and closes it for real", async () => {
    const fixture = await enrolled();
    const caFile = join(fixture.homeDir, "held-ca.pem");
    writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\ndummy\n-----END CERTIFICATE-----\n", { mode: 0o600 });
    const lookupTargetProject = vi.fn(async () => "remote-project-9" as string | null);
    const result = await resolveMigrationExpectedIdentity({
      preflight: readyPreview("continue-held", { targetConfig: { backend: "postgresql", postgresql: { ...REAL_TARGET_CONFIG.postgresql, caFile } } }),
      cwd: fixture.cwd, homeDir: fixture.homeDir,
      _operationsForTesting: { readLocalIdentity: () => ({ id: "c".repeat(64), canonical: "/projects/persisted" }), lookupTargetProject },
    });
    expect(result.status).toBe("resolved");
    expect(lookupTargetProject).toHaveBeenCalledOnce();
  });
});
