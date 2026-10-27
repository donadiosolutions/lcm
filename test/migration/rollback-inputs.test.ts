import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageIdentityContext } from "../../src/storage/contracts.js";
import type { BackendPublicationCoordinator } from "../../src/storage/backend-publication.js";
import { MigrationManifestStore } from "../../src/migration/manifest-store.js";
import { createMigrationManifest, type MigrationManifest } from "../../src/migration/protocol.js";
import { BackendPublicationJournalError } from "../../src/storage/backend-publication.js";
import { MigrationBindingUnresolvableError } from "../../src/migration/generation-binding-store.js";
import {
  DEFAULT_RESOLVE_ROLLBACK_CONTEXT_DEPENDENCIES,
  MIGRATION_ROLLBACK_ERROR_REASONS,
  MigrationRollbackError,
  RollbackInputResolutionError,
  createMigrationRollbackDependencies,
  resolveMigrationRollbackContext,
  runMigrationRollbackFromHome,
  toMigrationRollbackError,
  type MigrationRollbackErrorReason,
  type ResolveRollbackContextDependencies,
  type RollbackEntryDependencies,
} from "../../src/migration/rollback-inputs.js";
import { RollbackSessionError } from "../../src/migration/rollback-session.js";
import type { RollbackSessionDependencies, RollbackSessionTarget } from "../../src/migration/rollback-session.js";
import { RollbackOrchestrationError, deriveRollbackPublicationId } from "../../src/migration/rollback.js";

const HOME = "/home/user";
const GENERATION = "gen-1";
const PRESERVED = "preserved-gen";
const LOCAL = "local-project-1";
const REMOTE = "0197a000-0000-7000-8000-000000000001";
const MACHINE = "018f0b5d-1234-7abc-8def-1234567890ab";

const storage = {
  backend: "postgresql" as const,
  postgresql: {
    url: "postgresql://example/db", caFile: "/ca.pem", migrationRole: "lcm_owner",
    poolMax: 3, connectionTimeoutMs: 4, idleTimeoutMs: 5, statementTimeoutMs: 6, snapshotIdleTimeoutMs: 7,
  },
};

const snapshot = {
  artifact: {
    sourceSelectionSha256: "1".repeat(64),
    queueEvidenceSha256: "2".repeat(64),
    sourceByteWitnessSha256: "3".repeat(64),
    authority: {
      physicalProjectId: LOCAL,
      projectDbPath: "/home/user/.lcm/projects/" + LOCAL + "/db.sqlite",
      machineIdentity: { identityKey: "key", machineId: MACHINE },
    },
  },
  receiptReference: { queueCutoff: "0000000000000000042" },
};

function dependencies(overrides: Partial<ResolveRollbackContextDependencies> = {}): ResolveRollbackContextDependencies {
  return {
    readManifest: vi.fn(() => ({ rollbackLineage: { preservedSourceGenerationId: PRESERVED } }) as unknown as MigrationManifest),
    inspectSnapshot: vi.fn(async () => snapshot) as never,
    requireMachineIdentity: vi.fn(() => ({ machineId: MACHINE })) as never,
    readStorageConfig: vi.fn(() => storage),
    readProjectMap: vi.fn(() => ({ [LOCAL]: { canonical: "/work/project", aliases: [], remoteProjectId: REMOTE } })) as never,
    resolveIdentity: vi.fn((_config, local, _home, selectedPath) => ({
      id: local.remoteProjectId, canonical: local.canonical, remoteProjectId: local.remoteProjectId, machineId: MACHINE,
      selectedPath, localProjectId: local.id,
    })) as never,
    readOwnPublicationSource: vi.fn(() => null),
    ...overrides,
  };
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("resolveMigrationRollbackContext", () => {
  it("derives every input from the forward snapshot, the project map and the configuration", async () => {
    const deps = dependencies();
    const { input, target } = await resolveMigrationRollbackContext({ homeDir: HOME, generationId: GENERATION }, deps);

    expect(deps.inspectSnapshot).toHaveBeenCalledWith(PRESERVED, HOME);
    expect(input).toEqual({
      homeDir: HOME,
      generationId: GENERATION,
      canonicalPath: snapshot.artifact.authority.projectDbPath,
      projectIdentity: { scope: "shared", projectId: REMOTE },
      localProjectId: LOCAL,
      sourceSelectionSha256: "1".repeat(64),
      queueEvidenceSha256: "2".repeat(64),
      roster: [{ machineId: MACHINE, queueCutoff: "0000000000000000042", evidenceSha256: "3".repeat(64) }],
    });
    expect(target).toEqual({
      settings: {
        url: "postgresql://example/db", caFile: "/ca.pem", poolMax: 3, connectionTimeoutMs: 4,
        idleTimeoutMs: 5, statementTimeoutMs: 6, snapshotIdleTimeoutMs: 7,
      },
      expectedOwner: "lcm_owner",
      expectedIdentity: expect.objectContaining({ id: REMOTE, remoteProjectId: REMOTE, selectedPath: "/work/project", machineId: MACHINE }),
      localProjectId: LOCAL,
      remoteProjectId: REMOTE,
      machineId: MACHINE,
    });
    expect(deps.resolveIdentity).toHaveBeenCalledWith(
      storage, { id: LOCAL, canonical: "/work/project", remoteProjectId: REMOTE }, HOME, "/work/project",
    );
  });

  it("keeps a null queue cutoff for a forward capture that had none", async () => {
    const deps = dependencies({
      inspectSnapshot: vi.fn(async () => ({ ...snapshot, receiptReference: { queueCutoff: null } })) as never,
    });
    const { input } = await resolveMigrationRollbackContext({ homeDir: HOME, generationId: GENERATION }, deps);
    expect(input.roster[0]!.queueCutoff).toBeNull();
  });

  it("refuses when the forward capture's participant is another machine", async () => {
    const deps = dependencies({ requireMachineIdentity: vi.fn(() => ({ machineId: "another-machine" })) as never });
    await expect(resolveMigrationRollbackContext({ homeDir: HOME, generationId: GENERATION }, deps))
      .rejects.toMatchObject({ name: "RollbackInputResolutionError", reason: "machine-mismatch" });
  });

  it("refuses when the configuration no longer selects PostgreSQL", async () => {
    const deps = dependencies({ readStorageConfig: vi.fn(() => ({ backend: "sqlite" as const })) });
    await expect(resolveMigrationRollbackContext({ homeDir: HOME, generationId: GENERATION }, deps))
      .rejects.toMatchObject({ reason: "backend-not-postgresql" });
  });

  it("resolves the configuration and the map from the rollback's own sealed publication once it has begun", async () => {
    // The live files are the rollback's in-flight state (sqlite selected, project unbound); neither is read.
    const own = {
      storage,
      projectMap: { [LOCAL]: { canonical: "/work/project", aliases: [], remoteProjectId: REMOTE } },
    };
    const deps = dependencies({
      readOwnPublicationSource: vi.fn(() => own) as never,
      readStorageConfig: vi.fn(() => { throw new Error("live config must not be read"); }),
      readProjectMap: vi.fn(() => { throw new Error("live map must not be read"); }) as never,
    });
    const { input, target } = await resolveMigrationRollbackContext({ homeDir: HOME, generationId: GENERATION }, deps);
    expect(deps.readOwnPublicationSource).toHaveBeenCalledWith(HOME, deriveRollbackPublicationId(GENERATION), LOCAL);
    expect(input.localProjectId).toBe(LOCAL);
    expect(target.remoteProjectId).toBe(REMOTE);
    expect(target.settings.url).toBe("postgresql://example/db");
  });

  it("refuses an unbound project, and a project missing from the map", async () => {
    const unbound = dependencies({
      readProjectMap: vi.fn(() => ({ [LOCAL]: { canonical: "/work/project", aliases: [] } })) as never,
    });
    await expect(resolveMigrationRollbackContext({ homeDir: HOME, generationId: GENERATION }, unbound))
      .rejects.toMatchObject({ reason: "project-unbound", message: expect.stringContaining("lcm migration abort") });
    const missing = dependencies({ readProjectMap: vi.fn(() => ({})) as never });
    await expect(resolveMigrationRollbackContext({ homeDir: HOME, generationId: GENERATION }, missing))
      .rejects.toMatchObject({ reason: "project-unbound", message: expect.stringContaining("lcm migration abort") });
  });

  it("reads the manifest and the configuration from the home directory by default", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "lcm-rollback-inputs-"));
    roots.push(homeDir);
    mkdirSync(join(homeDir, ".lcm"), { mode: 0o700 });
    writeFileSync(join(homeDir, ".lcm", "config.json"), JSON.stringify({ storage: { backend: "sqlite" } }), { mode: 0o600 });
    const witness = { version: 1 as const, backend: "sqlite" as const, identitySha256: "a".repeat(64), schemaSha256: "b".repeat(64), contentSha256: "c".repeat(64), capturedAt: "2026-09-06T00:00:00.000Z" };
    new MigrationManifestStore({ homeDir }).create(createMigrationManifest({
      generationId: GENERATION, source: witness, destination: { ...witness, backend: "postgresql" },
      parentGenerationId: null, preservedSourceGenerationId: PRESERVED, createdAt: "2026-09-06T00:00:00.000Z",
    }));
    const deps: ResolveRollbackContextDependencies = {
      ...DEFAULT_RESOLVE_ROLLBACK_CONTEXT_DEPENDENCIES,
      inspectSnapshot: vi.fn(async () => snapshot) as never,
      requireMachineIdentity: vi.fn(() => ({ machineId: MACHINE })) as never,
    };
    // The real manifest store and the real configuration reader are used: the manifest names the
    // preserved generation, and the (sqlite) configuration is read and refused.
    await expect(resolveMigrationRollbackContext({ homeDir, generationId: GENERATION }, deps))
      .rejects.toMatchObject({ reason: "backend-not-postgresql" });
    expect(deps.inspectSnapshot).toHaveBeenCalledWith(PRESERVED, homeDir);
  });
});

describe("createMigrationRollbackDependencies", () => {
  it("supplies the coordinator and a session opener bound to the resolved target", async () => {
    const coordinator = {} as unknown as BackendPublicationCoordinator;
    const target = {
      settings: storage.postgresql, expectedOwner: "lcm_owner", expectedIdentity: {} as StorageIdentityContext,
      localProjectId: LOCAL, remoteProjectId: REMOTE, machineId: MACHINE,
    } as unknown as RollbackSessionTarget;
    const createRuntime = vi.fn(() => { throw new Error("runtime construction reached"); });
    const deps = createMigrationRollbackDependencies({
      coordinator, target, sessionDependencies: { createRuntime } as unknown as RollbackSessionDependencies,
    });
    expect(deps.coordinator).toBe(coordinator);
    await expect(deps.openFencedSession({
      homeDir: HOME, manifest: { generationId: GENERATION } as MigrationManifest, lockToken: {} as never,
    })).rejects.toThrow("runtime construction reached");
    expect(createRuntime).toHaveBeenCalledWith(target.settings);
  });
});

describe("RollbackInputResolutionError", () => {
  it("names its reason", () => {
    expect(new RollbackInputResolutionError("project-unbound", "m")).toMatchObject({
      name: "RollbackInputResolutionError", reason: "project-unbound", message: "m",
    });
  });
});


describe("runMigrationRollbackFromHome", () => {
  const outcome = { manifest: { phase: "rolled-back" }, report: null } as never;

  function harness(run: RollbackEntryDependencies["run"], contextOverrides: Partial<ResolveRollbackContextDependencies> = {}) {
    const guard = { acquire: vi.fn(), read: vi.fn(async () => null), release: vi.fn(), renew: vi.fn() };
    const runtime = { backendPublicationGuard: () => guard, close: vi.fn(async () => undefined) };
    const createCoordinator = vi.fn((options: unknown) => ({ options }) as unknown as BackendPublicationCoordinator);
    const session = {
      createRuntime: vi.fn(() => runtime),
      verifyRuntimeSchema: vi.fn(async () => { throw new Error("the schema check was reached"); }),
    } as unknown as RollbackSessionDependencies;
    const entryDependencies: RollbackEntryDependencies = {
      context: dependencies(contextOverrides),
      session,
      createCoordinator: createCoordinator as never,
      run,
    };
    return { guard, runtime, createCoordinator, session, entryDependencies };
  }

  it("resolves the inputs, builds the real coordinator over the runtime's guard, runs, and closes the runtime once", async () => {
    const signal = new AbortController().signal;
    const run = vi.fn(async () => outcome);
    const h = harness(run as never);

    await expect(runMigrationRollbackFromHome(
      { homeDir: HOME, generationId: GENERATION, scratchParent: "/scratch", signal }, h.entryDependencies,
    )).resolves.toBe(outcome);

    expect(h.session.createRuntime).toHaveBeenCalledTimes(1);
    const options = h.createCoordinator.mock.calls[0]![0] as { homeDir: string; remoteGuard: { mode: string; provider: Record<string, unknown> } };
    expect(options.homeDir).toBe(HOME);
    expect(options.remoteGuard.mode).toBe("delegated");
    expect(Object.keys(options.remoteGuard.provider).sort()).toEqual(["acquireRemoteGuard", "readRemoteGuard", "releaseRemoteGuard"]);
    const [input, deps] = run.mock.calls[0] as unknown as [Record<string, unknown>, { coordinator: unknown }];
    expect(input).toMatchObject({ homeDir: HOME, generationId: GENERATION, localProjectId: LOCAL, scratchParent: "/scratch", signal });
    expect(deps.coordinator).toEqual({ options });
    expect(h.runtime.close).toHaveBeenCalledTimes(1);
  });

  it("gives the session the entry's runtime but leaves closing it to the entry", async () => {
    const h = harness((async (_input: unknown, deps: { openFencedSession: (request: never) => Promise<unknown> }) => {
      await deps.openFencedSession({ homeDir: HOME, manifest: { generationId: GENERATION }, lockToken: {} } as never);
      return outcome;
    }) as never);

    await expect(runMigrationRollbackFromHome({ homeDir: HOME, generationId: GENERATION }, h.entryDependencies))
      .rejects.toMatchObject({ name: "MigrationRollbackError", reason: "unexpected-state", message: "the schema check was reached" });

    // The session failed to open and closed the runtime it was handed: that is the shared wrapper's no-op.
    expect(h.session.createRuntime).toHaveBeenCalledTimes(1);
    expect(h.runtime.close).toHaveBeenCalledTimes(1);
  });

  it("maps a failed input resolution without opening a runtime", async () => {
    const h = harness(vi.fn() as never, { readStorageConfig: () => ({ backend: "sqlite" }) as never });
    await expect(runMigrationRollbackFromHome({ homeDir: HOME, generationId: GENERATION }, h.entryDependencies))
      .rejects.toMatchObject({ reason: "input-unresolvable", message: expect.stringContaining("configuration selects another") });
    expect(h.session.createRuntime).not.toHaveBeenCalled();
  });

  const cases: ReadonlyArray<readonly [string, () => unknown, MigrationRollbackErrorReason]> = [
    ["a not-eligible refusal", () => new RollbackOrchestrationError("not-eligible", "refused"), "not-eligible"],
    ["export drift", () => new RollbackOrchestrationError("drift", "drifted"), "drift"],
    ["an unexpected state", () => new RollbackOrchestrationError("unexpected-state", "odd"), "unexpected-state"],
    ["an unimplemented reconciliation", () => new RollbackOrchestrationError("not-implemented", "later"), "unexpected-state"],
    ["a lost lease", () => new RollbackSessionError("lease-lost", "lost"), "lease-lost"],
    ["unsatisfied quiescence", () => new RollbackSessionError("quiescence-unsatisfied", "busy"), "quiescence-unsatisfied"],
    ["a lease held by another generation", () => new RollbackSessionError("lease-unavailable", "held"), "not-eligible"],
    ["a failed release", () => new RollbackSessionError("release-failed", "stuck"), "unexpected-state"],
    ["an unresolvable binding store", () => new MigrationBindingUnresolvableError("unreadable"), "unresolvable"],
    ["an unresolved publication", () => new BackendPublicationJournalError("unresolved-publication", "pending"), "unresolvable"],
    ["missing publication evidence", () => new BackendPublicationJournalError("publication-evidence-missing", "none"), "unresolvable"],
    ["another journal failure", () => new BackendPublicationJournalError("unsafe-storage", "unsafe"), "unexpected-state"],
    ["an unrelated Error", () => new Error("boom"), "unexpected-state"],
  ];
  it.each(cases)("maps %s onto the closed error, keeping the message and the cause", async (_name, make, reason) => {
    const failure = make() as Error;
    const h = harness((async () => { throw failure; }) as never);
    const error = await runMigrationRollbackFromHome({ homeDir: HOME, generationId: GENERATION }, h.entryDependencies)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationRollbackError);
    expect(error).toMatchObject({ reason, message: failure.message, cause: failure });
    expect(MIGRATION_ROLLBACK_ERROR_REASONS).toContain(reason);
    expect(h.runtime.close).toHaveBeenCalledTimes(1);
  });

  it("passes an already closed error through and stringifies a thrown non-error", async () => {
    const closed = new MigrationRollbackError("drift", "already mapped");
    expect(toMigrationRollbackError(closed)).toBe(closed);
    expect(toMigrationRollbackError("plain text")).toMatchObject({ reason: "unexpected-state", message: "plain text" });
  });

  it("exports the closed reason list #627 consumes", () => {
    expect(MIGRATION_ROLLBACK_ERROR_REASONS).toEqual([
      "not-eligible", "unresolvable", "lease-lost", "quiescence-unsatisfied", "drift", "input-unresolvable", "unexpected-state",
    ]);
  });
});
