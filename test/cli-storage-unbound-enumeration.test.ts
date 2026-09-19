import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { listCliProjects } from "../src/cli-storage.js";
import {
  clearProjectMapCache,
  hashProjectPath,
  normalizeProjectPath,
  projectMapPath,
  retiredProjectIdentitySuccessor,
  setRemoteProjectBinding,
} from "../src/project-map.js";
import { clearGitProjectAnchorCache } from "../src/git-project.js";
import { clearWorktreeReconciliationCache } from "../src/worktree-reconciliation.js";
import { ensureProjectDir, projectPaths } from "../src/daemon/project.js";
import { serializeWorktreeReconciliationFence } from "../src/worktree-reconciliation-fence.js";
import { UNBOUND_POSTGRESQL_PROJECT_MESSAGE } from "../src/storage/identity-context.js";
import { MachineIdentityFileError, recoverMachineIdentity } from "../src/machine-identity.js";
import {
  listProjects,
  type IdentityRepository,
  type IdentityServiceDependencies,
} from "../src/identity-service.js";
import { batchCompact, type CompactProgressEvent } from "../src/batch-compact.js";
import type { ResolvedStorageConfig } from "../src/daemon/config.js";
import * as configModule from "../src/daemon/config.js";
import * as publicationModule from "../src/storage/backend-publication.js";
import * as factoryModule from "../src/storage/factory.js";

// Bug #1403: listCliProjects() aborted the entire project enumeration when a
// single unbound, non-fenced local project-map entry was encountered under
// the PostgreSQL storage backend, instead of degrading that one entry the
// way the retired-fence branch already does. This file pins tests 1-9 from
// .superpowers/1403/PLAN.md section 4, as amended by deltas D3 and D4.

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const BOUND_REMOTE_ID = "01940000-0000-7000-8000-000000000001";

describe("#1403 - listCliProjects enumerates an unbound PostgreSQL entry instead of aborting", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lcm-1403-unbound-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    mkdirSync(join(home, ".lcm"), { mode: PRIVATE_DIRECTORY_MODE });
    chmodSync(join(home, ".lcm"), PRIVATE_DIRECTORY_MODE);
    writeFileSync(join(home, ".lcm", "machine.json"), JSON.stringify({
      version: 1,
      identityKey: "machine:" + "a".repeat(64),
      machineId: "01940000-0000-7000-8000-0000000000aa",
      displayName: "test",
    }), { mode: PRIVATE_FILE_MODE });
    clearProjectMapCache();
    clearGitProjectAnchorCache();
    clearWorktreeReconciliationCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    clearProjectMapCache();
    clearGitProjectAnchorCache();
    clearWorktreeReconciliationCache();
    rmSync(home, { recursive: true });
  });

  function makeProject(name: string): string {
    const path = join(home, name);
    mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    chmodSync(path, PRIVATE_DIRECTORY_MODE);
    return normalizeProjectPath(path);
  }

  function writeMap(map: Record<string, { canonical: string; aliases: string[]; remoteProjectId?: string }>): void {
    writeFileSync(projectMapPath(), `${JSON.stringify(map)}\n`, { mode: PRIVATE_FILE_MODE });
    clearProjectMapCache();
  }

  function plantPredecessorFence(retiredId: string): void {
    const projects = join(home, ".lcm", "projects");
    mkdirSync(projects, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    chmodSync(projects, PRIVATE_DIRECTORY_MODE);
    writeFileSync(
      join(projects, retiredId),
      serializeWorktreeReconciliationFence(retiredId, "project"),
      { mode: PRIVATE_FILE_MODE },
    );
    clearWorktreeReconciliationCache();
  }

  function selectPostgresqlBackend(): void {
    const config = configModule.loadDaemonConfig(join(home, ".lcm", "config.json"));
    vi.spyOn(configModule, "loadDaemonConfig").mockReturnValue({
      ...config,
      storage: { ...config.storage, backend: "postgresql" },
    });
    // Bypass real PostgreSQL publication-journal verification; only the
    // enumerator's identity-resolution branching is under test here.
    vi.spyOn(publicationModule, "assertBackendPublicationConsumerAccess").mockReturnValue(undefined);
  }

  // Test 1 (regression, fails on 862c517b): postgresql backend, one bound
  // entry and one unbound authenticated entry. Both must be enumerated.
  it("enumerates the unbound entry alongside the bound entry instead of aborting (regression for #1403)", async () => {
    const bound = makeProject("bound");
    const unbound = makeProject("unbound");
    const boundId = hashProjectPath(bound);
    const unboundId = hashProjectPath(unbound);
    writeMap({
      [boundId]: { canonical: bound, aliases: [], remoteProjectId: BOUND_REMOTE_ID },
      [unboundId]: { canonical: unbound, aliases: [] },
    });
    selectPostgresqlBackend();

    const listed = await listCliProjects();
    expect(listed).toHaveLength(2);
    expect(listed).toContainEqual({ id: BOUND_REMOTE_ID, canonical: bound, aliases: [bound] });
    expect(listed).toContainEqual({ id: unboundId, canonical: unbound, aliases: [unbound] });
  });

  // Test 2: an unbound-only map resolves to exactly that one entry instead
  // of rejecting.
  it("resolves to exactly the unbound entry when it is the only project in the map", async () => {
    const unbound = makeProject("only-unbound");
    const unboundId = hashProjectPath(unbound);
    writeMap({ [unboundId]: { canonical: unbound, aliases: [] } });
    selectPostgresqlBackend();

    await expect(listCliProjects()).resolves.toEqual([
      { id: unboundId, canonical: unbound, aliases: [unbound] },
    ]);
  });

  // Test 3: declared aliases are preserved for the unbound entry, with the
  // dedup path (Set over canonical + declared aliases) still exercised.
  it("preserves declared aliases for the unbound entry, deduplicated against its canonical path", async () => {
    const unbound = makeProject("unbound-aliased");
    const aliasTarget = makeProject("unbound-aliased-target");
    const unboundId = hashProjectPath(unbound);
    // The map's own canonical path is deliberately repeated in aliases so
    // the Set-based dedup in the enumerator is exercised, not merely
    // present.
    writeMap({ [unboundId]: { canonical: unbound, aliases: [unbound, aliasTarget] } });
    selectPostgresqlBackend();

    const listed = await listCliProjects();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: unboundId, canonical: unbound });
    expect(listed[0].aliases).toHaveLength(2);
    expect(new Set(listed[0].aliases)).toEqual(new Set([unbound, aliasTarget]));
  });

  // Test 4 (over-catch guard): a machine-wide MachineIdentityFileError for
  // the bound entry must still abort enumeration. Proves the catch added by
  // the fix is narrow to StorageIdentityConfigurationError.
  it("still aborts enumeration when the machine identity itself is broken", async () => {
    const bound = makeProject("bound-broken-machine");
    const unbound = makeProject("unbound-broken-machine");
    writeMap({
      [hashProjectPath(bound)]: { canonical: bound, aliases: [], remoteProjectId: BOUND_REMOTE_ID },
      [hashProjectPath(unbound)]: { canonical: unbound, aliases: [] },
    });
    rmSync(join(home, ".lcm", "machine.json"));
    selectPostgresqlBackend();

    await expect(listCliProjects()).rejects.toBeInstanceOf(MachineIdentityFileError);
  });

  // Test 5: the default SQLite backend is unaffected; an unbound entry
  // already enumerated correctly there and must continue to do so.
  it("still enumerates an unbound entry normally under the default SQLite backend", async () => {
    const unbound = makeProject("sqlite-unbound");
    const unboundId = hashProjectPath(unbound);
    writeMap({ [unboundId]: { canonical: unbound, aliases: [] } });

    await expect(listCliProjects()).resolves.toEqual([
      { id: unboundId, canonical: unbound, aliases: [unbound] },
    ]);
  });

  // Test 6 (guards main's #1357 work): a retired-identity fence still
  // enumerates under its own local identity under PostgreSQL, unaffected by
  // hoisting the fence check out of the guarded resolver region (D1).
  it("still enumerates a retired-identity fence under its own local identity under PostgreSQL", async () => {
    const cwd = makeProject("retired-fence-postgresql");
    const paths = projectPaths(cwd);
    ensureProjectDir(cwd);
    rmSync(paths.dir, { recursive: true });
    writeFileSync(paths.dir, serializeWorktreeReconciliationFence(paths.id, "project"), { mode: PRIVATE_FILE_MODE });
    clearWorktreeReconciliationCache();
    selectPostgresqlBackend();

    await expect(listCliProjects()).resolves.toEqual([
      { id: paths.id, canonical: cwd, aliases: [cwd] },
    ]);
  });

  // Test 7: "lcm project list" (listProjects, a different surface from
  // listCliProjects) already shows an unbound entry with no
  // remoteProjectId; this pins that no behavior change is needed there.
  it("keeps the unbound entry visible via the 'lcm project list' surface (no change required)", async () => {
    const unbound = makeProject("project-list-unbound");
    const unboundId = hashProjectPath(unbound);
    writeMap({ [unboundId]: { canonical: unbound, aliases: [] } });

    const config: ResolvedStorageConfig = {
      backend: "postgresql",
      postgresql: {
        url: "postgresql://user:secret@db.example/lcm",
        caFile: "/secure/ca.pem",
        poolMax: 5,
        connectionTimeoutMs: 10_000,
        idleTimeoutMs: 30_000,
        statementTimeoutMs: 60_000,
      },
    };
    const deps: Partial<IdentityServiceDependencies> = {
      homeDir: home,
      openSession: async () => ({
        repository: { listProjects: async () => [] } as unknown as IdentityRepository,
        close: async () => undefined,
      }),
      _assertBackendPublication: () => undefined,
    };

    const listing = await listProjects(config, deps);
    const entry = listing.local.find(item => item.hash === unboundId);
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({ hash: unboundId, canonical: unbound });
    expect(entry!.remoteProjectId).toBeUndefined();
  });

  // Test 9 (exact #1403 scenario, D4): a renewed successor identity - a
  // retired predecessor hash fenced at its own path, the successor keyed by
  // retiredProjectIdentitySuccessor with no remoteProjectId and its own
  // directory NOT a fence - alongside one ordinary bound project, under
  // PostgreSQL. Both must be enumerated.
  it("enumerates a renewed unbound successor identity under PostgreSQL alongside an ordinary bound project", async () => {
    const canonical = makeProject("renewed-unbound-postgresql");
    const retiredId = hashProjectPath(canonical);
    const successorId = retiredProjectIdentitySuccessor(retiredId, canonical);
    const bound = makeProject("ordinary-bound-postgresql");
    const boundId = hashProjectPath(bound);
    writeMap({
      [successorId]: { canonical, aliases: [] },
      [boundId]: { canonical: bound, aliases: [], remoteProjectId: BOUND_REMOTE_ID },
    });
    plantPredecessorFence(retiredId);
    selectPostgresqlBackend();

    const listed = await listCliProjects();
    expect(listed).toHaveLength(2);
    expect(listed).toContainEqual({ id: successorId, canonical, aliases: [canonical] });
    expect(listed).toContainEqual({ id: BOUND_REMOTE_ID, canonical: bound, aliases: [bound] });
  });
});

describe("#1403 - batch-compact reports the actionable unbound-project remedy", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let tempHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "lcm-1403-batch-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    rmSync(join(homedir(), ".lcm"), { recursive: true, force: true });
    mkdirSync(join(homedir(), ".lcm"), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    chmodSync(join(homedir(), ".lcm"), PRIVATE_DIRECTORY_MODE);
    clearProjectMapCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearProjectMapCache();
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  function makeDir(name: string): string {
    const path = join(homedir(), name);
    mkdirSync(path, { recursive: true });
    return path;
  }

  // Test 8 (D3, driven only through the public batchCompact({ onEvent })
  // seam, not the module-private discoverUncompacted or findUncompacted):
  // an unbound PostgreSQL project reports UNBOUND_POSTGRESQL_PROJECT_MESSAGE
  // as its own per-project failure while the other project is still
  // discovered, and the whole-run "project discovery failed" phase-failure
  // never appears.
  it("reports an unbound PostgreSQL project as a per-project failure while the other project is still discovered", async () => {
    const unboundCwd = makeDir("compact-postgresql-unbound");
    ensureProjectDir(unboundCwd);

    const boundCwd = makeDir("compact-postgresql-unbound-bound");
    recoverMachineIdentity({
      version: 1,
      identityKey: `machine:${"a".repeat(64)}`,
      machineId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9099",
      displayName: "Test machine",
    });
    setRemoteProjectBinding("018f22c4-6d2a-7f10-8a4c-6b8d3e5f9098", { canonical: boundCwd });

    const config = configModule.loadDaemonConfig(join(tempHome!, ".lcm", "config.json"));
    vi.spyOn(configModule, "loadDaemonConfig").mockReturnValue({
      ...config,
      storage: { ...config.storage, backend: "postgresql" },
    });
    // Bypass real PostgreSQL publication-journal verification and the real
    // network connection; only the enumeration/message-mapping fix is under
    // test here, not PostgreSQL storage itself.
    vi.spyOn(publicationModule, "assertBackendPublicationConsumerAccess").mockReturnValue(undefined);
    const realCreateStorageBackendFactory = factoryModule.createStorageBackendFactory;
    vi.spyOn(factoryModule, "createStorageBackendFactory").mockImplementation(async (...args) => {
      if (args[0].backend !== "postgresql") return realCreateStorageBackendFactory(...args);
      return {
        backend: "postgresql",
        capabilities: {},
        projectExists: async () => false,
        openExistingProject: async () => { throw new Error("postgresql storage unavailable in test"); },
        openProject: async () => { throw new Error("postgresql storage unavailable in test"); },
        health: async () => ({ ok: false }),
        close: async () => undefined,
      } as unknown as Awaited<ReturnType<typeof realCreateStorageBackendFactory>>;
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const events: CompactProgressEvent[] = [];
    await batchCompact({ minTokens: 100, dryRun: true, port: 3737, onEvent: event => events.push(event) });

    expect(events).toContainEqual(expect.objectContaining({
      type: "discovery-item-start",
      project: boundCwd,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "phase-failure",
      phase: "Compact",
      project: unboundCwd,
      message: UNBOUND_POSTGRESQL_PROJECT_MESSAGE,
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      message: "project discovery failed",
    }));
  });
});

