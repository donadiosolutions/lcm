import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBackendPublicationCoordinator,
  createBackendPublicationDriver,
  type BackendPublicationRemoteGuardProvider,
} from "../src/storage/backend-publication-driver.js";
import { composeBackendPublicationMaterial } from "../src/storage/backend-publication-material.js";
import { createInMemoryRemoteGuardProvider } from "./storage/backend-publication-guard-double.js";
import {
  BackendPublicationCoordinator,
  backendPublicationDirectory,
  type BackendPublicationFenceRecord,
} from "../src/storage/backend-publication.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "lcm-backend-publication-driver-"));
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  roots.push(home);
  return home;
}

function writeConfig(home: string, content: unknown): void {
  writeFileSync(join(home, ".lcm", "config.json"), `${JSON.stringify(content, null, 2)}
`, { mode: 0o600 });
}

function writeMap(home: string, content: unknown): void {
  writeFileSync(join(home, ".lcm", "map.json"), `${JSON.stringify(content, null, 2)}
`, { mode: 0o600 });
}

const HASH_A = "a".repeat(64);
const REMOTE_ID_A = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";
const EVIDENCE_A = "a".repeat(64);

function bindingA() {
  return { localProjectId: HASH_A, remoteProjectId: REMOTE_ID_A, evidenceSha256: EVIDENCE_A };
}

describe("createBackendPublicationDriver: remote guard choice validation", () => {
  it.each([
    ["undefined", undefined, /explicit object/],
    ["null", null, /explicit object/],
    ["a string", "absent", /explicit object/],
    ["a number", 1, /explicit object/],
    ["an unknown mode", { mode: "bogus" }, /mode "absent" or "delegated"/],
    ["absent without acknowledged", { mode: "absent" }, /acknowledged: true/],
    ["absent with acknowledged false", { mode: "absent", acknowledged: false }, /acknowledged: true/],
    ["delegated without a provider", { mode: "delegated" }, /requires a provider object/],
    ["delegated with a null provider", { mode: "delegated", provider: null }, /requires a provider object/],
    ["delegated with an empty provider", { mode: "delegated", provider: {} }, /missing required method: acquireRemoteGuard/],
    [
      "delegated missing releaseRemoteGuard",
      {
        mode: "delegated",
        provider: {
          acquireRemoteGuard: async () => undefined,
          readRemoteGuard: async () => null,
        },
      },
      /missing required method: releaseRemoteGuard/,
    ],
  ])("refuses when remoteGuard is %s", (_label, remoteGuard, expectedMessage) => {
    expect(() =>
      createBackendPublicationDriver({ remoteGuard: remoteGuard as any }),
    ).toThrow(expectedMessage);
  });

  it("accepts an explicit absent acknowledgement (positive control)", () => {
    const driver = createBackendPublicationDriver({
      remoteGuard: { mode: "absent", acknowledged: true },
    });
    expect(driver.observeLocalState).toBeInstanceOf(Function);
    expect(driver.publishConfig).toBeInstanceOf(Function);
    expect(driver.restoreConfig).toBeInstanceOf(Function);
    expect(driver.publishProjectMap).toBeInstanceOf(Function);
    expect(driver.restoreProjectMap).toBeInstanceOf(Function);
    expect(driver.acquireRemoteGuard).toBeUndefined();
    expect(driver.readRemoteGuard).toBeUndefined();
    expect(driver.releaseRemoteGuard).toBeUndefined();
    expect(driver.retainCompletedMaterial).toBeUndefined();
    expect(driver.cleanupAbortedMaterial).toBeUndefined();
  });

  it("wires the optional release-reconciliation read through only when the provider declares it (Bug #1651)", async () => {
    const provider: BackendPublicationRemoteGuardProvider = {
      acquireRemoteGuard: vi.fn(),
      readRemoteGuard: vi.fn(),
      releaseRemoteGuard: vi.fn(),
    };
    expect(createBackendPublicationDriver({ remoteGuard: { mode: "delegated", provider } })
      .readRemoteGuardForReleaseReconciliation).toBeUndefined();
    const reconcile = vi.fn(async () => null);
    const driver = createBackendPublicationDriver({
      remoteGuard: { mode: "delegated", provider: { ...provider, readRemoteGuardForReleaseReconciliation: reconcile } },
    });
    const context = { homeDir: undefined, journal: {} as never, project: {} as never };
    await expect(driver.readRemoteGuardForReleaseReconciliation!(context)).resolves.toBeNull();
    expect(reconcile).toHaveBeenCalledWith(context);
    expect(() => createBackendPublicationDriver({
      remoteGuard: { mode: "delegated", provider: { ...provider, readRemoteGuardForReleaseReconciliation: "no" as never } },
    })).toThrow(/readRemoteGuardForReleaseReconciliation must be a function/);
  });

  it("accepts a fully-implemented delegated provider (positive control) and wires all three methods through", async () => {
    const fence: BackendPublicationFenceRecord = {
      projectId: "p",
      machineId: "m",
      publicationId: "pub",
      targetBackend: "postgresql",
      evidenceSha256: "a".repeat(64),
      fencingToken: "1",
      acquiredAt: new Date().toISOString(),
      renewedAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
      releasedAt: null,
      databaseExpired: false,
    };
    const provider: BackendPublicationRemoteGuardProvider = {
      acquireRemoteGuard: vi.fn(async () => fence),
      readRemoteGuard: vi.fn(async () => fence),
      releaseRemoteGuard: vi.fn(async () => undefined),
    };
    const driver = createBackendPublicationDriver({
      remoteGuard: { mode: "delegated", provider },
    });
    expect(driver.acquireRemoteGuard).toBeInstanceOf(Function);
    expect(driver.readRemoteGuard).toBeInstanceOf(Function);
    expect(driver.releaseRemoteGuard).toBeInstanceOf(Function);
    const context = {
      homeDir: undefined,
      journal: {} as never,
      project: {} as never,
    };
    const acquired = await driver.acquireRemoteGuard!(context);
    expect(acquired).toBe(fence);
    expect(provider.acquireRemoteGuard).toHaveBeenCalledWith(context);
    const read = await driver.readRemoteGuard!(context, "acquire");
    expect(read).toBe(fence);
    expect(provider.readRemoteGuard).toHaveBeenCalledWith(context, "acquire");
    await driver.releaseRemoteGuard!({ ...context, fence });
    expect(provider.releaseRemoteGuard).toHaveBeenCalledWith({ ...context, fence });
  });
});

describe("createBackendPublicationCoordinator", () => {
  it("returns a real BackendPublicationCoordinator wired over the produced driver", () => {
    const home = makeHome();
    const coordinator = createBackendPublicationCoordinator({
      homeDir: home,
      remoteGuard: { mode: "absent", acknowledged: true },
    });
    expect(coordinator).toBeInstanceOf(BackendPublicationCoordinator);
  });

  it("refuses construction when remoteGuard is not explicitly chosen", () => {
    expect(() =>
      createBackendPublicationCoordinator({
        homeDir: makeHome(),
        remoteGuard: undefined as any,
      }),
    ).toThrow(/explicit object/);
  });
});

describe("explicit absent remote guard", () => {
  it("is refused for a publication that names projects, so absent is zero-project only", async () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeMap(home, { [HASH_A]: { canonical: "/repos/one", aliases: [] } });
    const composed = composeBackendPublicationMaterial({
      homeDir: home,
      targetBackend: "postgresql",
      bindings: [bindingA()],
    });
    const coordinator = createBackendPublicationCoordinator({
      homeDir: home,
      remoteGuard: { mode: "absent", acknowledged: true },
    });
    await expect(coordinator.prepare({
      publicationId: "pub-absent-with-projects",
      sourceBackend: composed.sourceBackend,
      targetBackend: composed.targetBackend,
      material: composed.material,
      projects: composed.projects,
    })).rejects.toThrow(/requires a complete remote guard provider/);
  });
});

describe("composition: a real coordinator over the real driver, through prepare/resume/completed and prepare/abort", () => {
  it("publishes bytes to disk on completion and restores exact bytes on abort, retaining then cleaning up material", async () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" }, unrelated: { keep: true } });
    writeMap(home, { [HASH_A]: { canonical: "/repos/one", aliases: [] } });

    const provider = createInMemoryRemoteGuardProvider();
    const coordinator = createBackendPublicationCoordinator({
      homeDir: home,
      remoteGuard: { mode: "delegated", provider },
    });

    // First publication: sqlite -> postgresql, binding one project.
    const composedActivation = composeBackendPublicationMaterial({
      homeDir: home,
      targetBackend: "postgresql",
      bindings: [bindingA()],
    });
    await coordinator.prepare({
      publicationId: "pub-activate",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material: composedActivation.material,
      projects: composedActivation.projects,
    });
    const completed = await coordinator.resume();
    expect(completed.phase).toBe("completed");

    const configPath = join(home, ".lcm", "config.json");
    const mapPath = join(home, ".lcm", "map.json");
    const afterActivationConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    const afterActivationMap = JSON.parse(readFileSync(mapPath, "utf-8"));
    expect(afterActivationConfig.storage.backend).toBe("postgresql");
    expect(afterActivationConfig.unrelated).toEqual({ keep: true });
    expect(afterActivationMap[HASH_A].remoteProjectId).toBe(REMOTE_ID_A);

    // Retention: the completed publication's material file is still present
    // and still matches its own on-disk bytes (nothing deletes it on the
    // completed path; retainCompletedMaterial is deliberately undefined).
    const activationMaterialPath = join(backendPublicationDirectory(home), "pub-activate.material");
    expect(existsSync(activationMaterialPath)).toBe(true);
    const retainedBytes = readFileSync(activationMaterialPath, "utf-8");
    expect(retainedBytes.length).toBeGreaterThan(0);

    // Second publication: postgresql -> sqlite (unbinding), then abort it
    // through the restore path instead of completing it.
    const composedRollback = composeBackendPublicationMaterial({
      homeDir: home,
      targetBackend: "sqlite",
      bindings: [bindingA()],
    });
    await coordinator.prepare({
      publicationId: "pub-rollback-attempt",
      sourceBackend: "postgresql",
      targetBackend: "sqlite",
      material: composedRollback.material,
      projects: composedRollback.projects,
    });
    const aborted = await coordinator.abort();
    expect(aborted.phase).toBe("aborted");

    const afterAbortConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    const afterAbortMap = JSON.parse(readFileSync(mapPath, "utf-8"));
    // The abort restores exactly the pre-second-prepare (post-activation)
    // state: still postgresql, still bound.
    expect(afterAbortConfig).toEqual(afterActivationConfig);
    expect(afterAbortMap).toEqual(afterActivationMap);

    // Cleanup: the aborted publication's material file is gone.
    // cleanupAbortedMaterial is deliberately undefined, so the coordinator's
    // own bounded, digest-verified deletion ran instead of a driver hook.
    const rollbackMaterialPath = join(backendPublicationDirectory(home), "pub-rollback-attempt.material");
    expect(existsSync(rollbackMaterialPath)).toBe(false);

    // The first publication's material is untouched by the second
    // publication's abort.
    expect(existsSync(activationMaterialPath)).toBe(true);
  });

  it("exercises the driver's restoreConfig and restoreProjectMap bodies when aborting a fully-published, not-yet-completed journal", async () => {
    const home = makeHome();
    writeConfig(home, { storage: { backend: "sqlite" } });
    writeMap(home, { [HASH_A]: { canonical: "/repos/one", aliases: [] } });

    const composed = composeBackendPublicationMaterial({
      homeDir: home,
      targetBackend: "postgresql",
      bindings: [bindingA()],
    });

    // A publication only needs restoring on abort if it actually reached
    // disk. Resume() drives all the way to "completed" in one call, so to
    // observe a genuinely published-but-not-completed journal, one driver
    // hook (retainCompletedMaterial, defined ONLY for this test) fails
    // right after release durably persists "released" but before the
    // journal transitions to "completed". That leaves real, on-disk
    // published bytes for a REAL abort (via the production, undecorated
    // driver) to restore.
    const provider = createInMemoryRemoteGuardProvider();
    const realDriver = createBackendPublicationDriver({
      remoteGuard: { mode: "delegated", provider },
    });
    const stuckDriver = {
      ...realDriver,
      retainCompletedMaterial: async () => {
        throw new Error("injected: stop before completed");
      },
    };
    const stuckCoordinator = new BackendPublicationCoordinator({ homeDir: home, driver: stuckDriver });
    await stuckCoordinator.prepare({
      publicationId: "pub-stuck",
      sourceBackend: "sqlite",
      targetBackend: "postgresql",
      material: composed.material,
      projects: composed.projects,
    });
    await expect(stuckCoordinator.resume()).rejects.toThrow(/injected/);

    const configPath = join(home, ".lcm", "config.json");
    const mapPath = join(home, ".lcm", "map.json");
    expect(JSON.parse(readFileSync(configPath, "utf-8")).storage.backend).toBe("postgresql");
    expect(JSON.parse(readFileSync(mapPath, "utf-8"))[HASH_A].remoteProjectId).toBe(REMOTE_ID_A);

    const realCoordinator = createBackendPublicationCoordinator({
      homeDir: home,
      remoteGuard: { mode: "delegated", provider },
    });
    const aborted = await realCoordinator.abort();
    expect(aborted.phase).toBe("aborted");
    expect(JSON.parse(readFileSync(configPath, "utf-8")).storage.backend).toBe("sqlite");
    expect("remoteProjectId" in JSON.parse(readFileSync(mapPath, "utf-8"))[HASH_A]).toBe(false);
  });
});
