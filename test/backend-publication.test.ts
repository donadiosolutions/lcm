import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackendPublicationCoordinator,
  BackendPublicationJournalError,
  assertBackendPublicationConsumerAccess,
  assertBackendPublicationConfigReadAccess,
  backendPublicationDirectory,
  backendPublicationJournalPath,
  backendPublicationCanonicalSha256,
  backendPublicationMaterialWitness,
  captureBackendPublicationFileWitness,
  readBackendPublicationJournal,
  withBackendPublicationConfigLock,
  withBackendPublicationConsumerLock,
  type BackendPublicationDriver,
  type BackendPublicationFenceRecord,
  type BackendPublicationRecoveryFile,
  type BackendPublicationRecoveryMaterial,
  type BackendPublicationStateWitness,
} from "../src/storage/backend-publication.js";
import { PrivateMutationPermitRevokedError } from "../src/private-mutation-lock.js";
import { withRevocablePrivateMutationPermit } from "../src/private-mutation-lock.js";
import {
  assertHomeLockTopology,
  closeHomeLockTopology,
  openHomeLockTopology,
  restoreHomeLockTopologyMode,
} from "../src/storage/home-lock-topology.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "lcm-backend-publication-"));
  mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  roots.push(home);
  return home;
}

function recoveryFile(content: string, mode = 0o600): BackendPublicationRecoveryFile {
  return {
    presence: "present",
    content: Buffer.from(content),
    mode,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    gid: typeof process.getgid === "function" ? process.getgid() : 0,
    nlink: "1",
    dev: "1",
    ino: "2",
    parentDev: "3",
    parentIno: "4",
  };
}

function material(): BackendPublicationRecoveryMaterial {
  return {
    source: {
      config: recoveryFile('{"backend":"sqlite"}'),
      projectMap: recoveryFile('{"projects":[]}'),
    },
    target: {
      config: recoveryFile('{"backend":"postgresql"}'),
      projectMap: recoveryFile('{"projects":["remote"]}'),
    },
  };
}

function targetState(input: BackendPublicationRecoveryMaterial): BackendPublicationStateWitness {
  return backendPublicationMaterialWitness({
    source: input.target,
    target: input.target,
  });
}

function sourceState(input: BackendPublicationRecoveryMaterial): BackendPublicationStateWitness {
  return backendPublicationMaterialWitness(input);
}

function projectInput() {
  return [{
    localProjectId: "local-project",
    remoteProjectId: "remote-project",
    evidenceSha256: "a".repeat(64),
  }] as const;
}

function makeDriver(input: BackendPublicationRecoveryMaterial): {
  driver: BackendPublicationDriver;
  getState: () => BackendPublicationStateWitness;
  setState: (state: BackendPublicationStateWitness) => void;
  calls: string[];
} {
  let state = sourceState(input);
  const expectedTarget = targetState(input);
  const calls: string[] = [];
  const driver: BackendPublicationDriver = {
    observeLocalState: vi.fn(async () => state),
    publishProjectMap: vi.fn(async ({ permit }) => {
      permit.assertActive();
      calls.push("publish-map");
      state = { ...state, projectMap: expectedTarget.projectMap };
      return expectedTarget.projectMap;
    }),
    publishConfig: vi.fn(async ({ permit }) => {
      permit.assertActive();
      calls.push("publish-config");
      state = { ...state, config: expectedTarget.config };
      return expectedTarget.config;
    }),
    restoreConfig: vi.fn(async ({ permit }) => {
      permit.assertActive();
      calls.push("restore-config");
      state = { ...state, config: sourceState(input).config };
      return sourceState(input).config;
    }),
    restoreProjectMap: vi.fn(async ({ permit }) => {
      permit.assertActive();
      calls.push("restore-map");
      state = { ...state, projectMap: sourceState(input).projectMap };
      return sourceState(input).projectMap;
    }),
  };
  return { driver, getState: () => state, setState: (next) => { state = next; }, calls };
}

function coordinator(
  homeDir: string,
  driver: BackendPublicationDriver,
  observer?: (event: string, path: string) => void,
): BackendPublicationCoordinator {
  return new BackendPublicationCoordinator({ homeDir, driver, observer });
}

async function withPatchedFsAsync<T>(
  name: string,
  replacement: unknown,
  callback: () => Promise<T>,
): Promise<T> {
  const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
  const original = nodeFs[name];
  nodeFs[name] = replacement;
  syncBuiltinESMExports();
  try {
    return await callback();
  } finally {
    nodeFs[name] = original;
    syncBuiltinESMExports();
  }
}

async function withTemporaryReboundPublicationMaterial(
  home: string,
  callback: () => unknown | Promise<unknown>,
): Promise<Readonly<{ injected: boolean; restored: boolean; error: unknown }>> {
  const publicationDirectory = backendPublicationDirectory(home);
  const originalDirectory = `${publicationDirectory}.original`;
  const materialPath = join(publicationDirectory, "publication-1.material");
  const materialContent = readFileSync(materialPath);
  const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
  const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
  const originalClose = nodeFs.closeSync as (fd: number) => void;
  let materialFd: number | undefined;
  let injected = false;
  let restored = false;
  let error: unknown;
  const restore = (): void => {
    if (!injected || restored) return;
    rmSync(publicationDirectory, { recursive: true, force: true });
    renameSync(originalDirectory, publicationDirectory);
    restored = true;
  };

  try {
    nodeFs.openSync = ((path: string, ...args: unknown[]) => {
      if (path !== materialPath || injected) return originalOpen(path, ...args);
      injected = true;
      renameSync(publicationDirectory, originalDirectory);
      mkdirSync(publicationDirectory, { mode: 0o700 });
      writeFileSync(materialPath, materialContent, { mode: 0o600 });
      materialFd = originalOpen(path, ...args);
      return materialFd;
    }) as never;
    nodeFs.closeSync = ((fd: number) => {
      originalClose(fd);
      if (fd === materialFd) {
        materialFd = undefined;
        restore();
      }
    }) as never;
    syncBuiltinESMExports();
    try {
      await callback();
    } catch (caught) {
      error = caught;
    }
  } finally {
    nodeFs.openSync = originalOpen;
    nodeFs.closeSync = originalClose;
    syncBuiltinESMExports();
    restore();
  }
  return { injected, restored, error };
}

function inputFor(materialInput: BackendPublicationRecoveryMaterial) {
  return {
    publicationId: "publication-1",
    sourceBackend: "sqlite" as const,
    targetBackend: "postgresql" as const,
    material: materialInput,
    projects: projectInput(),
    now: new Date("2026-08-06T12:00:00.000Z"),
  };
}

function fenceRecord(overrides: Partial<BackendPublicationFenceRecord> = {}): BackendPublicationFenceRecord {
  return {
    projectId: "remote-project",
    machineId: "machine-1",
    publicationId: "publication-1",
    targetBackend: "postgresql",
    evidenceSha256: "a".repeat(64),
    fencingToken: "1",
    acquiredAt: "2026-08-06T12:00:00.000Z",
    renewedAt: "2026-08-06T12:00:00.000Z",
    expiresAt: "2999-08-06T12:00:00.000Z",
    releasedAt: null,
    databaseExpired: false,
    ...overrides,
  };
}

async function releasingFixture(): Promise<{
  home: string;
  input: BackendPublicationRecoveryMaterial;
  fake: ReturnType<typeof makeDriver>;
  getFence: () => BackendPublicationFenceRecord | null;
  setFence: (fence: BackendPublicationFenceRecord | null) => void;
}> {
  const home = makeHome();
  const input = material();
  const fake = makeDriver(input);
  let currentFence: BackendPublicationFenceRecord | null = null;
  fake.driver.acquireRemoteGuard = vi.fn(async () => {
    currentFence = fenceRecord();
    return currentFence;
  });
  fake.driver.readRemoteGuard = vi.fn(async () => currentFence);
  fake.driver.releaseRemoteGuard = vi.fn(async () => {
    if (currentFence !== null) currentFence = fenceRecord({ releasedAt: "2026-08-06T12:01:00.000Z" });
  });
  await coordinator(home, fake.driver).prepare(inputFor(input));
  await expect(coordinator(home, fake.driver, (event) => {
    if (event === "before-release") throw new Error("crash:release-boundary");
  }).resume()).rejects.toThrow("crash:release-boundary");
  expect(readBackendPublicationJournal(home)?.phase).toBe("releasing");
  return {
    home,
    input,
    fake,
    getFence: () => currentFence,
    setFence: (fence) => { currentFence = fence; },
  };
}

function rewriteJournal(
  home: string,
  mutate: (journal: Record<string, unknown>) => Record<string, unknown>,
): void {
  const path = backendPublicationJournalPath(home);
  const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const next = mutate(current);
  const { checksumSha256: _checksum, ...payload } = next;
  writeFileSync(path, `${JSON.stringify({
    ...payload,
    checksumSha256: backendPublicationCanonicalSha256(payload),
  })}\n`, { mode: 0o600 });
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function configReadWitness(path: string): {
  presence: "absent" | "present";
  rawSha256: string | null;
  byteLength: number;
  dev: string | null;
  ino: string | null;
} {
  const witness = captureBackendPublicationFileWitness(path, join(path, ".."), 4 * 1024 * 1024).witness;
  return {
    presence: witness.presence,
    rawSha256: witness.rawSha256,
    byteLength: witness.byteLength,
    dev: witness.dev,
    ino: witness.ino,
  };
}

function rewriteMaterial(home: string, content: string): void {
  const path = join(backendPublicationDirectory(home), "publication-1.material");
  writeFileSync(path, content, { mode: 0o600 });
  rewriteJournal(home, (journal) => ({
    ...journal,
    recoveryReference: {
      relativePath: "publication-1.material",
      sealSha256: sha256(content),
      byteLength: Buffer.byteLength(content),
    },
  }));
}

async function preparedFixture(): Promise<{
  home: string;
  input: BackendPublicationRecoveryMaterial;
  fake: ReturnType<typeof makeDriver>;
}> {
  const home = makeHome();
  const input = material();
  const fake = makeDriver(input);
  await coordinator(home, fake.driver).prepare(inputFor(input));
  return { home, input, fake };
}

async function expectJournalReadFailure(
  mutate: (journal: Record<string, unknown>) => Record<string, unknown>,
  reason: BackendPublicationJournalError["reason"] = "malformed-journal",
): Promise<void> {
  const { home } = await preparedFixture();
  rewriteJournal(home, mutate);
  let thrown: unknown;
  try {
    readBackendPublicationJournal(home);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ reason });
}

async function expectMaterialReadFailure(
  content: string,
  reason: BackendPublicationJournalError["reason"] = "malformed-journal",
): Promise<void> {
  const { home, fake } = await preparedFixture();
  rewriteMaterial(home, content);
  await expect(coordinator(home, fake.driver).resume()).rejects.toMatchObject({ reason });
}

describe("BackendPublicationCoordinator", () => {
  it("journals preparing before sealing, authenticates material, and resumes to completion", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    const events: string[] = [];
    const prepared = await coordinator(home, fake.driver, (event) => events.push(event)).prepare(inputFor(input));

    expect(prepared.phase).toBe("prepared");
    expect(events.indexOf("before-journal-write")).toBeLessThan(events.indexOf("before-material-seal"));
    expect(readBackendPublicationJournal(home)).toMatchObject({ phase: "prepared", publicationId: "publication-1" });
    expect(readFileSync(join(backendPublicationDirectory(home), "publication-1.material"), "utf8")).toContain("cG9zdGdyZXNxbCJ9");

    const completed = await coordinator(home, fake.driver).resume();
    expect(completed.phase).toBe("completed");
    expect(fake.calls).toEqual(["publish-map", "publish-config"]);
    expect(fake.getState()).toEqual(targetState(input));
    expect(await coordinator(home, fake.driver).recoverPending()).toEqual(completed);
  });

  it("archives terminal journal evidence before starting the next publication", async () => {
    const home = makeHome();
    const input = material();
    const first = makeDriver(input);
    await coordinator(home, first.driver).prepare(inputFor(input));
    await expect(coordinator(home, first.driver).prepare(inputFor(input)))
      .rejects.toMatchObject({ reason: "unresolved-publication" });
    await coordinator(home, first.driver).resume();

    const second = makeDriver(input);
    const next = await coordinator(home, second.driver).prepare({
      ...inputFor(input),
      publicationId: "publication-2",
    });
    expect(next.phase).toBe("prepared");
    expect(existsSync(join(backendPublicationDirectory(home), "history"))).toBe(true);
    expect(readBackendPublicationJournal(home)?.publicationId).toBe("publication-2");
    await coordinator(home, second.driver).resume();
    const third = makeDriver(input);
    await expect(coordinator(home, third.driver).prepare({
      ...inputFor(input),
      publicationId: "publication-3",
    })).resolves.toMatchObject({ phase: "prepared" });
  });

  it("retains terminal journal evidence when observation fails after history is archived", async () => {
    const home = makeHome();
    const input = material();
    const first = makeDriver(input);
    await coordinator(home, first.driver).prepare(inputFor(input));
    const completed = await coordinator(home, first.driver).resume();
    const archivePath = join(
      backendPublicationDirectory(home),
      "history",
      completed.publicationId + "." + completed.checksumSha256 + ".json",
    );

    const second = makeDriver(input);
    second.driver.observeLocalState = vi.fn(async () => {
      throw new Error("crash:observe-after-archive");
    });
    const nextInput = { ...inputFor(input), publicationId: "publication-2" };
    await expect(coordinator(home, second.driver).prepare(nextInput))
      .rejects.toThrow("crash:observe-after-archive");

    expect(readBackendPublicationJournal(home)).toMatchObject({
      phase: "completed",
      publicationId: "publication-1",
    });
    expect(existsSync(archivePath)).toBe(true);
    expect(() => assertBackendPublicationConsumerAccess({ homeDir: home, backend: "postgresql" })).not.toThrow();

    second.driver.observeLocalState = vi.fn(async () => sourceState(input));
    await expect(coordinator(home, second.driver).prepare(nextInput))
      .resolves.toMatchObject({ phase: "prepared", publicationId: "publication-2" });
    expect(existsSync(archivePath)).toBe(true);
  });

  it("leaves the prior terminal journal active when replacement publication fails", async () => {
    const home = makeHome();
    const input = material();
    const first = makeDriver(input);
    await coordinator(home, first.driver).prepare(inputFor(input));
    const completed = await coordinator(home, first.driver).resume();
    const archivePath = join(
      backendPublicationDirectory(home),
      "history",
      completed.publicationId + "." + completed.checksumSha256 + ".json",
    );
    const second = makeDriver(input);
    const nextInput = { ...inputFor(input), publicationId: "publication-2" };

    await expect(coordinator(home, second.driver, (event) => {
      if (event === "before-journal-write") throw new Error("crash:before-replacement");
    }).prepare(nextInput)).rejects.toThrow("crash:before-replacement");

    expect(readBackendPublicationJournal(home)).toMatchObject({
      phase: "completed",
      publicationId: "publication-1",
    });
    expect(existsSync(archivePath)).toBe(true);
    await expect(coordinator(home, second.driver).prepare(nextInput))
      .resolves.toMatchObject({ phase: "prepared", publicationId: "publication-2" });
  });

  it("keeps a durably published preparing replacement after the post-write crash boundary", async () => {
    const home = makeHome();
    const input = material();
    const first = makeDriver(input);
    await coordinator(home, first.driver).prepare(inputFor(input));
    const completed = await coordinator(home, first.driver).resume();
    const archivePath = join(
      backendPublicationDirectory(home),
      "history",
      completed.publicationId + "." + completed.checksumSha256 + ".json",
    );
    const second = makeDriver(input);
    await expect(coordinator(home, second.driver, (event) => {
      if (event === "after-journal-write") throw new Error("crash:after-replacement");
    }).prepare({ ...inputFor(input), publicationId: "publication-2" }))
      .rejects.toThrow("crash:after-replacement");

    expect(readBackendPublicationJournal(home)).toMatchObject({
      phase: "preparing",
      publicationId: "publication-2",
    });
    expect(existsSync(archivePath)).toBe(true);
  });

  it("resumes idempotently from already-published local state and retains material", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await coordinator(home, fake.driver).prepare(inputFor(input));
    fake.driver.observeLocalState = vi.fn(async () => targetState(input));
    const retained = vi.fn(async () => undefined);
    fake.driver.retainCompletedMaterial = retained;
    const completed = await coordinator(home, fake.driver).resume();
    expect(completed.phase).toBe("completed");
    expect(fake.driver.publishProjectMap).not.toHaveBeenCalled();
    expect(fake.driver.publishConfig).not.toHaveBeenCalled();
    expect(retained).toHaveBeenCalledOnce();
  });

  it("finalizes a journal already at the released checkpoint", async () => {
    const { home, fake } = await preparedFixture();
    rewriteJournal(home, (journal) => ({ ...journal, phase: "released" }));
    expect((await coordinator(home, fake.driver).resume()).phase).toBe("completed");
  });

  it("binds logical checks to exact BigInt-derived identities and rejects changed evidence", async () => {
    const input = material();
    const exactSource: BackendPublicationStateWitness = {
      config: { ...sourceState(input).config, dev: "9007199254740993", ino: "9007199254740995", parentDev: "7", parentIno: "11" },
      projectMap: { ...sourceState(input).projectMap, dev: "9007199254740993", ino: "9007199254740997", parentDev: "7", parentIno: "11" },
    };
    const home = makeHome();
    let state = exactSource;
    const expected = targetState(input);
    const driver: BackendPublicationDriver = {
      observeLocalState: vi.fn(async () => state),
      publishProjectMap: vi.fn(async ({ permit }) => {
        permit.assertActive();
        state = { ...state, projectMap: expected.projectMap };
        return state.projectMap;
      }),
      publishConfig: vi.fn(async ({ permit }) => {
        permit.assertActive();
        state = { ...state, config: expected.config };
        return state.config;
      }),
      restoreConfig: vi.fn(async ({ permit }) => {
        permit.assertActive();
        state = { ...state, config: exactSource.config };
        return state.config;
      }),
      restoreProjectMap: vi.fn(async ({ permit }) => {
        permit.assertActive();
        state = { ...state, projectMap: exactSource.projectMap };
        return state.projectMap;
      }),
    };
    await coordinator(home, driver).prepare(inputFor(input));
    expect((await coordinator(home, driver).resume()).phase).toBe("completed");

    const mismatchHome = makeHome();
    let mismatchState = exactSource;
    const mismatchDriver: BackendPublicationDriver = {
      ...driver,
      observeLocalState: vi.fn(async () => mismatchState),
    };
    await coordinator(mismatchHome, mismatchDriver).prepare(inputFor(input));
    mismatchState = {
      ...exactSource,
      projectMap: { ...exactSource.projectMap, ino: "9007199254740999" },
    };
    await expect(coordinator(mismatchHome, mismatchDriver).resume()).rejects.toMatchObject({ reason: "unexpected-state" });
  });

  it("recovers from map and config publishing checkpoints", async () => {
    for (const checkpoint of ["map-publishing", "config-publishing"] as const) {
      const home = makeHome();
      const input = material();
      const fake = makeDriver(input);
      await coordinator(home, fake.driver).prepare(inputFor(input));
      let crashed = false;
      const observer = (event: string): void => {
        if (!crashed && event === "after-journal-write" && readBackendPublicationJournal(home)?.phase === checkpoint) {
          crashed = true;
          throw new Error(`crash:${checkpoint}`);
        }
      };
      await expect(coordinator(home, fake.driver, observer).resume()).rejects.toThrow(`crash:${checkpoint}`);
      expect(readBackendPublicationJournal(home)?.phase).toBe(checkpoint);
      expect((await coordinator(home, fake.driver).resume()).phase).toBe("completed");
    }
  });

  it("adopts an identity-changing map publication after a crash before its witness checkpoint", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await coordinator(home, fake.driver).prepare(inputFor(input));
    const originalPublishMap = fake.driver.publishProjectMap;
    const changedTargetMap = {
      ...targetState(input).projectMap,
      dev: "101",
      ino: "102",
      parentDev: "103",
      parentIno: "104",
    };
    fake.driver.publishProjectMap = async (mutation) => {
      await originalPublishMap(mutation);
      fake.setState({ ...fake.getState(), projectMap: changedTargetMap });
      throw new Error("crash:after-map-identity");
    };

    await expect(coordinator(home, fake.driver).resume()).rejects.toThrow("crash:after-map-identity");
    expect(readBackendPublicationJournal(home)?.phase).toBe("map-publishing");

    fake.driver.publishProjectMap = vi.fn(async () => {
      throw new Error("replayed map publication");
    });
    const completed = await coordinator(home, fake.driver).resume();
    expect(completed.phase).toBe("completed");
    expect(completed.targetState.projectMap).toMatchObject({
      dev: "101",
      ino: "102",
      parentDev: "103",
      parentIno: "104",
    });
    expect(fake.calls).toEqual(["publish-map", "publish-config"]);
  });

  it("aborts an identity-changing map publication before its witness checkpoint", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await coordinator(home, fake.driver).prepare(inputFor(input));
    const originalPublishMap = fake.driver.publishProjectMap;
    const changedTargetMap = {
      ...targetState(input).projectMap,
      dev: "121",
      ino: "122",
      parentDev: "123",
      parentIno: "124",
    };
    fake.driver.publishProjectMap = async (mutation) => {
      await originalPublishMap(mutation);
      fake.setState({ ...fake.getState(), projectMap: changedTargetMap });
      throw new Error("crash:after-map-identity-abort");
    };

    await expect(coordinator(home, fake.driver).resume()).rejects.toThrow("crash:after-map-identity-abort");
    const aborted = await coordinator(home, fake.driver).abort();
    expect(aborted.phase).toBe("aborted");
    expect(fake.calls).toEqual(["publish-map", "restore-map"]);
  });

  it("adopts an identity-changing config publication after a crash before its witness checkpoint", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await coordinator(home, fake.driver).prepare(inputFor(input));
    const originalPublishConfig = fake.driver.publishConfig;
    const changedTargetConfig = {
      ...targetState(input).config,
      dev: "111",
      ino: "112",
      parentDev: "113",
      parentIno: "114",
    };
    fake.driver.publishConfig = async (mutation) => {
      await originalPublishConfig(mutation);
      fake.setState({ ...fake.getState(), config: changedTargetConfig });
      throw new Error("crash:after-config-identity");
    };

    await expect(coordinator(home, fake.driver).resume()).rejects.toThrow("crash:after-config-identity");
    expect(readBackendPublicationJournal(home)?.phase).toBe("config-publishing");

    fake.driver.publishConfig = vi.fn(async () => {
      throw new Error("replayed config publication");
    });
    const completed = await coordinator(home, fake.driver).resume();
    expect(completed.phase).toBe("completed");
    expect(completed.targetState.config).toMatchObject({
      dev: "111",
      ino: "112",
      parentDev: "113",
      parentIno: "114",
    });
    expect(fake.calls).toEqual(["publish-map", "publish-config"]);
  });

  it("adopts an identity-changing config restoration after a crash before its witness checkpoint", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await coordinator(home, fake.driver).prepare(inputFor(input));
    const originalPublishConfig = fake.driver.publishConfig;
    fake.driver.publishConfig = async (mutation) => {
      await originalPublishConfig(mutation);
      throw new Error("crash:after-config");
    };
    await expect(coordinator(home, fake.driver).resume()).rejects.toThrow("crash:after-config");
    expect(readBackendPublicationJournal(home)?.phase).toBe("config-publishing");

    const originalRestoreConfig = fake.driver.restoreConfig;
    const changedSourceConfig = {
      ...sourceState(input).config,
      dev: "201",
      ino: "202",
      parentDev: "203",
      parentIno: "204",
    };
    fake.driver.restoreConfig = async (mutation) => {
      await originalRestoreConfig(mutation);
      fake.setState({ ...fake.getState(), config: changedSourceConfig });
      throw new Error("crash:after-config-restore-identity");
    };
    await expect(coordinator(home, fake.driver).abort()).rejects.toThrow("crash:after-config-restore-identity");
    expect(readBackendPublicationJournal(home)?.phase).toBe("config-restoring");

    fake.driver.restoreConfig = vi.fn(async () => {
      throw new Error("replayed config restoration");
    });
    const aborted = await coordinator(home, fake.driver).abort();
    expect(aborted.phase).toBe("aborted");
    expect(aborted.sourceState.config).toMatchObject({
      dev: "201",
      ino: "202",
      parentDev: "203",
      parentIno: "204",
    });
    expect(fake.calls).toEqual(["publish-map", "publish-config", "restore-config", "restore-map"]);
  });

  it("adopts an identity-changing project-map restoration after a crash before its witness checkpoint", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await coordinator(home, fake.driver).prepare(inputFor(input));
    const originalPublishConfig = fake.driver.publishConfig;
    fake.driver.publishConfig = async (mutation) => {
      await originalPublishConfig(mutation);
      throw new Error("crash:after-config");
    };
    await expect(coordinator(home, fake.driver).resume()).rejects.toThrow("crash:after-config");

    const originalRestoreMap = fake.driver.restoreProjectMap;
    const changedSourceMap = {
      ...sourceState(input).projectMap,
      dev: "211",
      ino: "212",
      parentDev: "213",
      parentIno: "214",
    };
    fake.driver.restoreProjectMap = async (mutation) => {
      await originalRestoreMap(mutation);
      fake.setState({ ...fake.getState(), projectMap: changedSourceMap });
      throw new Error("crash:after-map-restore-identity");
    };
    await expect(coordinator(home, fake.driver).abort()).rejects.toThrow("crash:after-map-restore-identity");
    expect(readBackendPublicationJournal(home)?.phase).toBe("map-restoring");

    fake.driver.restoreProjectMap = vi.fn(async () => {
      throw new Error("replayed map restoration");
    });
    const aborted = await coordinator(home, fake.driver).abort();
    expect(aborted.phase).toBe("aborted");
    expect(aborted.sourceState.projectMap).toMatchObject({
      dev: "211",
      ino: "212",
      parentDev: "213",
      parentIno: "214",
    });
    expect(fake.calls).toEqual(["publish-map", "publish-config", "restore-config", "restore-map"]);
  });

  it("rejects a third or tampered state at an identity-changing publication seam", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await coordinator(home, fake.driver).prepare(inputFor(input));
    const originalPublishMap = fake.driver.publishProjectMap;
    fake.driver.publishProjectMap = async (mutation) => {
      await originalPublishMap(mutation);
      fake.setState({
        ...fake.getState(),
        projectMap: {
          ...targetState(input).projectMap,
          rawSha256: "f".repeat(64),
          semanticSha256: "e".repeat(64),
        },
      });
      throw new Error("crash:after-map-tamper");
    };

    await expect(coordinator(home, fake.driver).resume()).rejects.toThrow("crash:after-map-tamper");
    await expect(coordinator(home, fake.driver).resume()).rejects.toMatchObject({ reason: "unexpected-state" });
  });

  it("checkpoints remote fences and resumes forward after a release crash", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    let fence: BackendPublicationFenceRecord | null = null;
    let releaseCrashed = false;
    const makeFence = (releasedAt: string | null): BackendPublicationFenceRecord => ({
      projectId: "remote-project",
      machineId: "machine-1",
      publicationId: "publication-1",
      targetBackend: "postgresql",
      evidenceSha256: "a".repeat(64),
      fencingToken: "1",
      acquiredAt: "2026-08-06T12:00:00.000Z",
      renewedAt: "2026-08-06T12:00:00.000Z",
      expiresAt: "2999-08-06T12:00:00.000Z",
      releasedAt,
      databaseExpired: false,
    });
    fake.driver.acquireRemoteGuard = async () => {
      fence = makeFence(null);
      return fence;
    };
    fake.driver.readRemoteGuard = async () => fence;
    fake.driver.releaseRemoteGuard = async () => {
      if (!releaseCrashed) releaseCrashed = true;
      fence = makeFence("2026-08-06T12:01:00.000Z");
    };
    await coordinator(home, fake.driver).prepare(inputFor(input));
    const crashing = coordinator(home, fake.driver, (event) => {
      if (event === "before-release" && releaseCrashed === false) throw new Error("crash:release");
    });
    await expect(crashing.resume()).rejects.toThrow("crash:release");
    expect(readBackendPublicationJournal(home)?.phase).toBe("releasing");

    const recovered = await coordinator(home, fake.driver).recoverPending();
    expect(recovered?.phase).toBe("completed");
    expect(fence?.releasedAt).not.toBeNull();
  });

  it("handles optional remote admission seams and already-active fences", async () => {
    const absentReadHome = makeHome();
    const absentRead = makeDriver(material());
    absentRead.driver.acquireRemoteGuard = vi.fn(async () => fenceRecord());
    await expect(coordinator(absentReadHome, absentRead.driver).prepare(inputFor(material())))
      .resolves.toMatchObject({ phase: "prepared" });
    await expect(coordinator(absentReadHome, absentRead.driver).resume()).resolves.toMatchObject({ phase: "completed" });
    expect(absentRead.driver.acquireRemoteGuard).not.toHaveBeenCalled();

    const activeHome = makeHome();
    const active = makeDriver(material());
    let current = fenceRecord();
    active.driver.acquireRemoteGuard = vi.fn(async () => current);
    active.driver.readRemoteGuard = vi.fn(async () => current);
    active.driver.releaseRemoteGuard = vi.fn(async () => {
      current = fenceRecord({ releasedAt: "2026-08-06T12:01:00.000Z" });
    });
    await coordinator(activeHome, active.driver).prepare(inputFor(material()));
    const completed = await coordinator(activeHome, active.driver).resume();
    expect(completed.phase).toBe("completed");
    expect(active.driver.acquireRemoteGuard).not.toHaveBeenCalled();
    expect(active.driver.releaseRemoteGuard).toHaveBeenCalledOnce();
  });

  it("acquires and releases projects in canonical order", async () => {
    const home = makeHome();
    const input = {
      ...inputFor(material()),
      projects: [
        { localProjectId: "z-project", remoteProjectId: "remote-z", evidenceSha256: "b".repeat(64) },
        { localProjectId: "a-project", remoteProjectId: "remote-a", evidenceSha256: "c".repeat(64) },
      ],
    } as const;
    const fake = makeDriver(material());
    const fences = new Map<string, BackendPublicationFenceRecord>();
    fake.driver.acquireRemoteGuard = vi.fn(async ({ project }) => {
      const next = fenceRecord({ projectId: project.remoteProjectId, evidenceSha256: project.evidenceSha256 });
      fences.set(project.remoteProjectId, next);
      return next;
    });
    fake.driver.readRemoteGuard = vi.fn(async ({ project }) => fences.get(project.remoteProjectId) ?? null);
    fake.driver.releaseRemoteGuard = vi.fn(async ({ project }) => {
      const current = fences.get(project.remoteProjectId);
      if (current !== undefined) fences.set(project.remoteProjectId, { ...current, releasedAt: "2026-08-06T12:01:00.000Z" });
    });
    await coordinator(home, fake.driver).prepare(input);
    const completed = await coordinator(home, fake.driver).resume();
    expect(completed.phase).toBe("completed");
    expect(fake.driver.acquireRemoteGuard).toHaveBeenCalledTimes(2);
    expect(fake.driver.releaseRemoteGuard).toHaveBeenCalledTimes(2);
    expect(fake.driver.acquireRemoteGuard.mock.calls.map(([call]) => call.project.remoteProjectId))
      .toEqual(["remote-a", "remote-z"]);
  });

  it("fails closed when remote acquisition cannot prove an active fence", async () => {
    const home = makeHome();
    const fake = makeDriver(material());
    let reads = 0;
    fake.driver.acquireRemoteGuard = vi.fn(async () => fenceRecord());
    fake.driver.readRemoteGuard = vi.fn(async () => {
      reads += 1;
      return reads === 1 ? null : fenceRecord({ databaseExpired: true });
    });
    await coordinator(home, fake.driver).prepare(inputFor(material()));
    await expect(coordinator(home, fake.driver).resume()).rejects.toMatchObject({ reason: "unexpected-state" });

    const mismatchHome = makeHome();
    const mismatch = makeDriver(material());
    mismatch.driver.acquireRemoteGuard = vi.fn(async () => fenceRecord());
    mismatch.driver.readRemoteGuard = vi.fn(async () => fenceRecord({ projectId: "other-project" }));
    await coordinator(mismatchHome, mismatch.driver).prepare(inputFor(material()));
    await expect(coordinator(mismatchHome, mismatch.driver).resume()).rejects.toMatchObject({ reason: "unexpected-state" });

    const tokenHome = makeHome();
    const token = makeDriver(material());
    token.driver.acquireRemoteGuard = vi.fn(async () => fenceRecord());
    token.driver.readRemoteGuard = vi.fn(async () => fenceRecord({ fencingToken: "not-a-number" }));
    await coordinator(tokenHome, token.driver).prepare(inputFor(material()));
    await expect(coordinator(tokenHome, token.driver).resume()).rejects.toMatchObject({ reason: "unexpected-state" });
  });

  // This matrix performs repeated durable journal/fsync setup and exceeds Vitest's 5s
  // default under V8 coverage.
  it("fails closed for every uncertain or conflicting remote release witness", async () => {
    const missing = await releasingFixture();
    missing.fake.driver.readRemoteGuard = vi.fn(async () => null);
    await expect(coordinator(missing.home, missing.fake.driver).recoverPending()).rejects.toMatchObject({ reason: "unexpected-state" });

    const identity = await releasingFixture();
    identity.fake.driver.readRemoteGuard = vi.fn(async () => fenceRecord({ machineId: "other-machine" }));
    await expect(coordinator(identity.home, identity.fake.driver).recoverPending()).rejects.toMatchObject({ reason: "unexpected-state" });

    const regressed = await releasingFixture();
    regressed.fake.driver.readRemoteGuard = vi.fn(async () => fenceRecord({ fencingToken: "0" }));
    await expect(coordinator(regressed.home, regressed.fake.driver).recoverPending()).rejects.toMatchObject({ reason: "unexpected-state" });

    for (const successor of [
      fenceRecord({ fencingToken: "2", releasedAt: "2026-08-06T12:01:00.000Z" }),
      fenceRecord({ fencingToken: "2", databaseExpired: true }),
    ]) {
      const fixture = await releasingFixture();
      fixture.fake.driver.readRemoteGuard = vi.fn(async () => successor);
      await expect(coordinator(fixture.home, fixture.fake.driver).recoverPending()).rejects.toMatchObject({ reason: "unexpected-state" });
    }

    const activeSuccessor = await releasingFixture();
    let activeReads = 0;
    activeSuccessor.fake.driver.readRemoteGuard = vi.fn(async () => {
      activeReads += 1;
      return activeReads === 1
        ? fenceRecord({ fencingToken: "2" })
        : fenceRecord({ fencingToken: "2", releasedAt: "2026-08-06T12:01:00.000Z" });
    });
    const activeRecovered = await coordinator(activeSuccessor.home, activeSuccessor.fake.driver).recoverPending();
    expect(activeRecovered?.phase).toBe("completed");

    const expiredRecovered = await releasingFixture();
    let expiredReads = 0;
    expiredRecovered.fake.driver.acquireRemoteGuard = vi.fn(async () => fenceRecord({ fencingToken: "2" }));
    expiredRecovered.fake.driver.readRemoteGuard = vi.fn(async () => {
      expiredReads += 1;
      if (expiredReads === 1) return fenceRecord({ databaseExpired: true });
      if (expiredReads === 2) return fenceRecord({ fencingToken: "2" });
      return fenceRecord({ fencingToken: "2", releasedAt: "2026-08-06T12:01:00.000Z" });
    });
    const expiredCompleted = await coordinator(expiredRecovered.home, expiredRecovered.fake.driver).recoverPending();
    expect(expiredCompleted?.phase).toBe("completed");

    const abortingRelease = await releasingFixture();
    const abortingCompleted = await coordinator(abortingRelease.home, abortingRelease.fake.driver).abort();
    expect(abortingCompleted.phase).toBe("aborted");

    const alreadyReleased = await releasingFixture();
    alreadyReleased.setFence(fenceRecord({ releasedAt: "2026-08-06T12:01:00.000Z" }));
    const alreadyReleasedResult = await coordinator(alreadyReleased.home, alreadyReleased.fake.driver).recoverPending();
    expect(alreadyReleasedResult?.phase).toBe("completed");
    expect(alreadyReleased.fake.driver.releaseRemoteGuard).not.toHaveBeenCalled();

    const expiredWithoutAcquire = await releasingFixture();
    expiredWithoutAcquire.fake.driver.acquireRemoteGuard = undefined;
    expiredWithoutAcquire.fake.driver.readRemoteGuard = vi.fn(async () => fenceRecord({ databaseExpired: true }));
    await expect(coordinator(expiredWithoutAcquire.home, expiredWithoutAcquire.fake.driver).recoverPending())
      .rejects.toMatchObject({ reason: "unexpected-state" });

    const reacquireMissing = await releasingFixture();
    let reacquireMissingReads = 0;
    reacquireMissing.fake.driver.acquireRemoteGuard = vi.fn(async () => fenceRecord({ fencingToken: "2" }));
    reacquireMissing.fake.driver.readRemoteGuard = vi.fn(async () => {
      reacquireMissingReads += 1;
      return reacquireMissingReads === 1 ? fenceRecord({ databaseExpired: true }) : null;
    });
    await expect(coordinator(reacquireMissing.home, reacquireMissing.fake.driver).recoverPending())
      .rejects.toMatchObject({ reason: "unexpected-state" });

    const reacquireUnusable = await releasingFixture();
    let reacquireUnusableReads = 0;
    reacquireUnusable.fake.driver.acquireRemoteGuard = vi.fn(async () => fenceRecord({ fencingToken: "2" }));
    reacquireUnusable.fake.driver.readRemoteGuard = vi.fn(async () => {
      reacquireUnusableReads += 1;
      return reacquireUnusableReads === 1
        ? fenceRecord({ databaseExpired: true })
        : fenceRecord({ fencingToken: "2", releasedAt: "2026-08-06T12:01:00.000Z" });
    });
    await expect(coordinator(reacquireUnusable.home, reacquireUnusable.fake.driver).recoverPending())
      .rejects.toMatchObject({ reason: "unexpected-state" });

    const reacquireSameToken = await releasingFixture();
    let reacquireSameReads = 0;
    reacquireSameToken.fake.driver.acquireRemoteGuard = vi.fn(async () => fenceRecord());
    reacquireSameToken.fake.driver.readRemoteGuard = vi.fn(async () => {
      reacquireSameReads += 1;
      return reacquireSameReads === 1 ? fenceRecord({ databaseExpired: true }) : fenceRecord();
    });
    await expect(coordinator(reacquireSameToken.home, reacquireSameToken.fake.driver).recoverPending())
      .rejects.toMatchObject({ reason: "unexpected-state" });

    const noReadback = await releasingFixture();
    let noReadbackReads = 0;
    noReadback.fake.driver.readRemoteGuard = vi.fn(async () => {
      noReadbackReads += 1;
      return fenceRecord();
    });
    noReadback.fake.driver.releaseRemoteGuard = vi.fn(async () => undefined);
    await expect(coordinator(noReadback.home, noReadback.fake.driver).recoverPending())
      .rejects.toMatchObject({ reason: "unexpected-state" });

    for (const changed of [
      fenceRecord({ machineId: "other-machine", releasedAt: "2026-08-06T12:01:00.000Z" }),
      fenceRecord({ fencingToken: "0", releasedAt: "2026-08-06T12:01:00.000Z" }),
    ]) {
      const fixture = await releasingFixture();
      let releaseReads = 0;
      fixture.fake.driver.readRemoteGuard = vi.fn(async () => {
        releaseReads += 1;
        return releaseReads === 1 ? fenceRecord() : changed;
      });
      fixture.fake.driver.releaseRemoteGuard = vi.fn(async () => undefined);
      await expect(coordinator(fixture.home, fixture.fake.driver).recoverPending())
        .rejects.toMatchObject({ reason: "unexpected-state" });
    }

    const skipped = await releasingFixture();
    rewriteJournal(skipped.home, (journal) => ({
      ...journal,
      projects: [
        ...((journal.projects as Record<string, unknown>[])),
        {
          localProjectId: "local-project-z",
          remoteProjectId: "remote-project-z",
          evidenceSha256: "b".repeat(64),
          fence: null,
        },
      ],
    }));
    const skippedRecovered = await coordinator(skipped.home, skipped.fake.driver).recoverPending();
    expect(skippedRecovered?.phase).toBe("completed");

    const successor = await releasingFixture();
    rewriteJournal(successor.home, (journal) => ({
      ...journal,
      projects: [
        ...((journal.projects as Record<string, unknown>[])),
        {
          localProjectId: "local-project-z",
          remoteProjectId: "remote-project-z",
          evidenceSha256: "b".repeat(64),
          fence: fenceRecord({ projectId: "remote-project-z", evidenceSha256: "b".repeat(64) }),
        },
      ],
    }));
    let firstReads = 0;
    let secondReads = 0;
    successor.fake.driver.acquireRemoteGuard = vi.fn(async () => fenceRecord({
      projectId: "remote-project-z",
      evidenceSha256: "b".repeat(64),
      fencingToken: "2",
    }));
    successor.fake.driver.readRemoteGuard = vi.fn(async ({ project }) => {
      if (project.remoteProjectId === "remote-project") {
        firstReads += 1;
        return firstReads === 1
          ? fenceRecord({ fencingToken: "2" })
          : fenceRecord({ fencingToken: "2", releasedAt: "2026-08-06T12:01:00.000Z" });
      }
      secondReads += 1;
      if (secondReads === 1) return fenceRecord({ projectId: "remote-project-z", evidenceSha256: "b".repeat(64), databaseExpired: true });
      if (secondReads === 2) return fenceRecord({ projectId: "remote-project-z", evidenceSha256: "b".repeat(64), fencingToken: "2" });
      return fenceRecord({ projectId: "remote-project-z", evidenceSha256: "b".repeat(64), fencingToken: "2", releasedAt: "2026-08-06T12:01:00.000Z" });
    });
    successor.fake.driver.releaseRemoteGuard = vi.fn(async () => undefined);
    expect((await coordinator(successor.home, successor.fake.driver).recoverPending())?.phase).toBe("completed");
  }, 15_000);

  it("releases remote fences while aborting before local publication", async () => {
    const home = makeHome();
    const input = inputFor(material());
    const fake = makeDriver(material());
    let current = fenceRecord();
    fake.driver.acquireRemoteGuard = vi.fn(async () => current);
    fake.driver.readRemoteGuard = vi.fn(async () => current);
    fake.driver.releaseRemoteGuard = vi.fn(async () => {
      current = fenceRecord({ releasedAt: "2026-08-06T12:01:00.000Z" });
    });
    await coordinator(home, fake.driver).prepare(input);
    await expect(coordinator(home, fake.driver, (event) => {
      if (event === "before-material-authenticate" && readBackendPublicationJournal(home)?.phase === "guarded") {
        throw new Error("crash:after-remote-acquire");
      }
    }).resume()).rejects.toThrow("crash:after-remote-acquire");
    const aborted = await coordinator(home, fake.driver).recoverPending({ disposition: "abort" });
    expect(aborted?.phase).toBe("aborted");
    expect(fake.driver.releaseRemoteGuard).toHaveBeenCalledOnce();
    expect(existsSync(join(backendPublicationDirectory(home), "publication-1.material"))).toBe(false);
  });

  it("captures exact descriptor and parent identities for consumer state witnesses", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await coordinator(home, fake.driver).prepare(inputFor(input));
    const path = join(backendPublicationDirectory(home), "observed");
    writeFileSync(path, "observed", { mode: 0o600 });
    const captured = captureBackendPublicationFileWitness(path, backendPublicationDirectory(home));
    expect(captured.content).toBe("observed");
    expect(captured.witness.presence).toBe("present");
    if (captured.witness.presence === "present") {
      expect(captured.witness.dev).toMatch(/^\d+$/u);
      expect(captured.witness.ino).toMatch(/^\d+$/u);
      expect(captured.witness.parentDev).toMatch(/^\d+$/u);
      expect(captured.witness.parentIno).toMatch(/^\d+$/u);
    }
    expect(captureBackendPublicationFileWitness(join(backendPublicationDirectory(home), "missing"), backendPublicationDirectory(home)))
      .toEqual({ content: null, witness: expect.objectContaining({ presence: "absent" }) });
    const directoryPath = join(backendPublicationDirectory(home), "directory");
    mkdirSync(directoryPath, { mode: 0o700 });
    expect(() => captureBackendPublicationFileWitness(directoryPath, backendPublicationDirectory(home)))
      .toThrow("regular file");

    const uidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
      expect(captureBackendPublicationFileWitness(path, backendPublicationDirectory(home)).content).toBe("observed");
    } finally {
      if (uidDescriptor === undefined) delete (process as { getuid?: unknown }).getuid;
      else Object.defineProperty(process, "getuid", uidDescriptor);
    }
  });

  it("rejects captured regular files outside the owner-readable mode domain", async () => {
    const home = makeHome();
    const directory = backendPublicationDirectory(home);
    mkdirSync(directory, { mode: 0o700 });
    const path = join(directory, "group-readable");
    writeFileSync(path, "observed", { mode: 0o640 });

    expect(() => captureBackendPublicationFileWitness(path, directory)).toThrow("mode is not trusted");
  });

  it.each([
    0o000,
    0o100,
    0o200,
    0o300,
    0o640,
    0o604,
    0o644,
    0o1000,
    0o2000,
    0o4000,
    0o7000,
  ])("rejects journal witness mode %o before authentication", async (mode) => {
    await expectJournalReadFailure((journal) => ({
      ...journal,
      sourceState: {
        ...(journal.sourceState as Record<string, unknown>),
        config: {
          ...((journal.sourceState as { config: Record<string, unknown> }).config),
          mode,
        },
      },
    }));
  });

  it("supports runtimes without a getuid syscall", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
      await coordinator(home, fake.driver).prepare(inputFor(input));
      await expect(coordinator(home, fake.driver).resume()).resolves.toMatchObject({ phase: "completed" });
      await expect(coordinator(home, makeDriver(input).driver).prepare({
        ...inputFor(input),
        publicationId: "publication-2",
      })).resolves.toMatchObject({ phase: "prepared" });
    } finally {
      if (descriptor === undefined) delete (process as { getuid?: unknown }).getuid;
      else Object.defineProperty(process, "getuid", descriptor);
    }
  });

  it("recovers a crash after material seal without orphaning or overwriting the journal", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    let crashed = false;
    const crashObserver = (event: string): void => {
      if (event === "after-material-seal" && !crashed) {
        crashed = true;
        throw new Error("crash:material-seal");
      }
    };

    await expect(coordinator(home, fake.driver, crashObserver).prepare(inputFor(input)))
      .rejects.toThrow("crash:material-seal");
    expect(readBackendPublicationJournal(home)?.phase).toBe("preparing");
    expect(readFileSync(join(backendPublicationDirectory(home), "publication-1.material"), "utf8")).toContain("eyJiYWNrZW5kIjoic3FsaXRl");

    const recovered = await coordinator(home, fake.driver).recoverPending();
    expect(recovered?.phase).toBe("completed");
    expect(fake.calls).toEqual(["publish-map", "publish-config"]);
  });

  it("authenticates and cleans a sealed material file when aborting before prepared", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await expect(coordinator(home, fake.driver, (event) => {
      if (event === "after-material-seal") throw new Error("crash:before-prepared");
    }).prepare(inputFor(input))).rejects.toThrow("crash:before-prepared");

    const aborted = await coordinator(home, fake.driver).abort();
    expect(aborted.phase).toBe("aborted");
    expect(existsSync(join(backendPublicationDirectory(home), "publication-1.material"))).toBe(false);
  });

  it("fails closed and preserves tampered recovery material", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await coordinator(home, fake.driver).prepare(inputFor(input));
    const path = join(backendPublicationDirectory(home), "publication-1.material");
    writeFileSync(path, "tampered", { mode: 0o600 });

    await expect(coordinator(home, fake.driver).resume()).rejects.toMatchObject<BackendPublicationJournalError>({
      reason: "checksum-mismatch",
    });
    expect(readFileSync(path, "utf8")).toBe("tampered");
    expect(readBackendPublicationJournal(home)?.phase).toBe("guarded");
  });

  it("rejects unsafe and oversized recovery input before creating a seal", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await expect(coordinator(home, fake.driver).prepare(inputFor({
      ...input,
      target: { ...input.target, config: recoveryFile("x", 0o644) },
    }))).rejects.toMatchObject({ reason: "invalid-input" });
    await expect(coordinator(home, fake.driver).prepare(inputFor({
      ...input,
      target: { ...input.target, config: { ...recoveryFile("x"), content: Buffer.alloc(4 * 1024 * 1024 + 1) } },
    }))).rejects.toMatchObject({ reason: "invalid-input" });
    expect(readBackendPublicationJournal(home)).toBeNull();
  });

  it("rejects recovery material that exceeds the sealed envelope bound", async () => {
    const home = makeHome();
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const gid = typeof process.getgid === "function" ? process.getgid() : 0;
    const huge: BackendPublicationRecoveryFile = {
      presence: "present",
      content: Buffer.alloc(4 * 1024 * 1024, 0x78),
      mode: 0o600,
      uid,
      gid,
      nlink: "1",
      dev: "1",
      ino: "2",
      parentDev: "3",
      parentIno: "4",
    };
    const hugeMaterial: BackendPublicationRecoveryMaterial = {
      source: { config: huge, projectMap: huge },
      target: { config: huge, projectMap: huge },
    };
    const fake = makeDriver(hugeMaterial);
    await expect(coordinator(home, fake.driver).prepare(inputFor(hugeMaterial)))
      .rejects.toMatchObject({ reason: "invalid-input" });
    expect(readBackendPublicationJournal(home)?.phase).toBe("preparing");
  });

  it("aborts a pre-release partial publication and restores source state", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await coordinator(home, fake.driver).prepare(inputFor(input));
    const publishMap = fake.driver.publishProjectMap;
    fake.driver.publishProjectMap = async (mutation) => {
      await publishMap(mutation);
      throw new Error("crash:after-map");
    };
    await expect(coordinator(home, fake.driver).resume()).rejects.toThrow("crash:after-map");
    expect(readBackendPublicationJournal(home)?.phase).toBe("map-publishing");

    const aborted = await coordinator(home, fake.driver).abort();
    expect(aborted.phase).toBe("aborted");
    expect(fake.getState()).toEqual(sourceState(input));
    expect(fake.calls).toContain("restore-map");
  });

  it("keeps a preparing journal fail-closed when sealing did not happen", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    const observer = (event: string): void => {
      if (event === "before-material-seal") throw new Error("crash:before-seal");
    };
    await expect(coordinator(home, fake.driver, observer).prepare(inputFor(input))).rejects.toThrow("crash:before-seal");
    await expect(coordinator(home, fake.driver).recoverPending()).rejects.toThrow();
    expect(readBackendPublicationJournal(home)?.phase).toBe("preparing");
    expect(readBackendPublicationJournal(home)?.recoveryReference).toBeNull();
  });

  it("aborts an unsealed journal and fails closed on an untrusted sealed journal", async () => {
    const missingHome = makeHome();
    const missingInput = material();
    const missingFake = makeDriver(missingInput);
    await expect(coordinator(missingHome, missingFake.driver, (event) => {
      if (event === "before-material-seal") throw new Error("crash:before-seal-abort");
    }).prepare(inputFor(missingInput))).rejects.toThrow("crash:before-seal-abort");
    await expect(coordinator(missingHome, missingFake.driver).abort()).resolves.toMatchObject({ phase: "aborted" });
    await expect(coordinator(missingHome, missingFake.driver).abort()).resolves.toMatchObject({ phase: "aborted" });

    const tamperedHome = makeHome();
    const tamperedInput = material();
    const tamperedFake = makeDriver(tamperedInput);
    await expect(coordinator(tamperedHome, tamperedFake.driver, (event) => {
      if (event === "after-material-seal") throw new Error("crash:sealed-abort");
    }).prepare(inputFor(tamperedInput))).rejects.toThrow("crash:sealed-abort");
    writeFileSync(join(backendPublicationDirectory(tamperedHome), "publication-1.material"), "tampered", { mode: 0o600 });
    await expect(coordinator(tamperedHome, tamperedFake.driver).abort()).rejects.toMatchObject({ reason: "malformed-journal" });
  });

  it("restores published files during abort and uses operator cleanup callbacks", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await coordinator(home, fake.driver).prepare(inputFor(input));
    const originalPublishConfig = fake.driver.publishConfig;
    fake.driver.publishConfig = async (mutation) => {
      await originalPublishConfig(mutation);
      throw new Error("crash:after-config");
    };
    await expect(coordinator(home, fake.driver).resume()).rejects.toThrow("crash:after-config");
    expect(readBackendPublicationJournal(home)?.phase).toBe("config-publishing");
    const cleanup = vi.fn(async () => undefined);
    fake.driver.cleanupAbortedMaterial = cleanup;
    const aborted = await coordinator(home, fake.driver).abort();
    expect(aborted.phase).toBe("aborted");
    expect(fake.getState()).toEqual(sourceState(input));
    expect(fake.calls).toEqual(["publish-map", "publish-config", "restore-config", "restore-map"]);
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(coordinator(home, fake.driver).abort()).resolves.toMatchObject({ phase: "aborted" });
  });

  it("retries config and map restoration checkpoints after recovery crashes", async () => {
    const home = makeHome();
    const input = material();
    const fake = makeDriver(input);
    await coordinator(home, fake.driver).prepare(inputFor(input));
    const originalPublishConfig = fake.driver.publishConfig;
    fake.driver.publishConfig = async (mutation) => {
      await originalPublishConfig(mutation);
      throw new Error("crash:after-config-retry");
    };
    await expect(coordinator(home, fake.driver).resume()).rejects.toThrow("crash:after-config-retry");
    let crashConfig = true;
    const configObserver = (event: string): void => {
      if (crashConfig && event === "after-journal-write" && readBackendPublicationJournal(home)?.phase === "config-restoring") {
        crashConfig = false;
        throw new Error("crash:config-restoring");
      }
    };
    await expect(coordinator(home, fake.driver, configObserver).abort()).rejects.toThrow("crash:config-restoring");
    expect(readBackendPublicationJournal(home)?.phase).toBe("config-restoring");
    let crashMap = true;
    const mapObserver = (event: string): void => {
      if (crashMap && event === "after-journal-write" && readBackendPublicationJournal(home)?.phase === "map-restoring") {
        crashMap = false;
        throw new Error("crash:map-restoring");
      }
    };
    await expect(coordinator(home, fake.driver, mapObserver).resume()).rejects.toThrow("crash:map-restoring");
    expect(readBackendPublicationJournal(home)?.phase).toBe("map-restoring");
    expect((await coordinator(home, fake.driver).abort()).phase).toBe("aborted");
  });

  it("covers canonical witness helpers and absent material shapes", () => {
    expect(() => backendPublicationCanonicalSha256(undefined)).toThrow(TypeError);
    expect(backendPublicationMaterialWitness({
      source: {
        config: recoveryFile("not-json"),
        projectMap: { presence: "absent" },
      },
      target: {
        config: { presence: "absent" },
        projectMap: recoveryFile("not-json"),
      },
    })).toMatchObject({
      config: { presence: "present" },
      projectMap: { presence: "absent" },
    });
    expect(backendPublicationDirectory()).toContain(".lcm/backend-publication");
  });

  it("fails closed for malformed observed state and witness mismatches", async () => {
    const malformedHome = makeHome();
    const malformed = makeDriver(material());
    malformed.driver.observeLocalState = vi.fn(async () => null as never);
    await expect(coordinator(malformedHome, malformed.driver).prepare(inputFor(material())))
      .rejects.toMatchObject({ reason: "malformed-journal" });

    const malformedAbsentHome = makeHome();
    const malformedAbsent = makeDriver(material());
    malformedAbsent.driver.observeLocalState = vi.fn(async () => ({
      config: { presence: "absent", rawSha256: "bad" } as never,
      projectMap: sourceState(material()).projectMap,
    }));
    await expect(coordinator(malformedAbsentHome, malformedAbsent.driver).prepare(inputFor(material())))
      .rejects.toMatchObject({ reason: "malformed-journal" });

    const mismatchHome = makeHome();
    const mismatch = makeDriver(material());
    await coordinator(mismatchHome, mismatch.driver).prepare(inputFor(material()));
    mismatch.driver.observeLocalState = vi.fn(async () => ({
      ...mismatch.getState(),
      projectMap: { ...mismatch.getState().projectMap, rawSha256: "b".repeat(64) },
    }));
    await expect(coordinator(mismatchHome, mismatch.driver).resume())
      .rejects.toMatchObject({ reason: "unexpected-state" });

    const contentHome = makeHome();
    const content = makeDriver(material());
    const altered = sourceState(material());
    content.driver.observeLocalState = vi.fn(async () => ({
      ...altered,
      config: { ...altered.config, uid: altered.config.presence === "present" ? altered.config.uid + 1 : 1 },
    }));
    await expect(coordinator(contentHome, content.driver).prepare(inputFor(material())))
      .rejects.toMatchObject({ reason: "unexpected-state" });

    const absentHome = makeHome();
    const absentMaterial: BackendPublicationRecoveryMaterial = {
      source: { config: { presence: "absent" }, projectMap: { presence: "absent" } },
      target: { config: { presence: "absent" }, projectMap: { presence: "absent" } },
    };
    const absent = makeDriver(absentMaterial);
    await expect(coordinator(absentHome, absent.driver).prepare(inputFor(absentMaterial)))
      .resolves.toMatchObject({ phase: "prepared", intendedConfigSha256: sha256("{}") });
  });

  it("rejects each top-level input and timestamp boundary", async () => {
    const valid = inputFor(material());
    const cases: readonly [string, unknown][] = [
      ["not an object", null],
      ["invalid publication id", { ...valid, publicationId: "bad id" }],
      ["invalid source backend", { ...valid, sourceBackend: "redis" }],
      ["invalid target backend", { ...valid, targetBackend: "redis" }],
      ["same backend", { ...valid, targetBackend: "sqlite" }],
      ["invalid material", { ...valid, material: null }],
      ["invalid source material", { ...valid, material: { ...valid.material, source: null } }],
      ["invalid target material", { ...valid, material: { ...valid.material, target: null } }],
      ["invalid projects", { ...valid, projects: null }],
      ["invalid date", { ...valid, now: new Date("invalid") }],
    ];
    for (const [label, candidate] of cases) {
      const home = makeHome();
      const fake = makeDriver(material());
      await expect(coordinator(home, fake.driver).prepare(candidate as never), label)
        .rejects.toMatchObject({ reason: "invalid-input" });
    }

    const noDate = makeHome();
    const noDateDriver = makeDriver(material());
    const { now: _now, ...withoutDate } = valid;
    await expect(coordinator(noDate, noDateDriver.driver).prepare(withoutDate))
      .resolves.toMatchObject({ phase: "prepared" });
  });

  it("rejects malformed recovery files, project coverage, and noncanonical project order", async () => {
    const valid = inputFor(material());
    const invalidMaterials: readonly [string, unknown][] = [
      ["invalid presence", { ...valid.material, source: { ...valid.material.source, config: {} } }],
      ["empty content", { ...valid.material, source: { ...valid.material.source, config: recoveryFile("") } }],
      ["broad mode", { ...valid.material, source: { ...valid.material.source, config: recoveryFile("x", 0o644) } }],
      ["negative uid", { ...valid.material, source: { ...valid.material.source, config: { ...recoveryFile("x"), uid: -1 } } }],
      ["negative gid", { ...valid.material, source: { ...valid.material.source, config: { ...recoveryFile("x"), gid: -1 } } }],
    ];
    for (const [label, candidate] of invalidMaterials) {
      const home = makeHome();
      const fake = makeDriver(material());
      await expect(coordinator(home, fake.driver).prepare({ ...valid, material: candidate as never }), label)
        .rejects.toMatchObject({ reason: "invalid-input" });
    }

    const invalidProjects: readonly [string, readonly Record<string, unknown>[]][] = [
      ["missing local id", [{ remoteProjectId: "remote", evidenceSha256: "a".repeat(64) }]],
      ["missing remote id", [{ localProjectId: "local", evidenceSha256: "a".repeat(64) }]],
      ["invalid evidence", [{ localProjectId: "local", remoteProjectId: "remote", evidenceSha256: "bad" }]],
      ["duplicate local id", [
        { localProjectId: "local", remoteProjectId: "remote-a", evidenceSha256: "a".repeat(64) },
        { localProjectId: "local", remoteProjectId: "remote-b", evidenceSha256: "b".repeat(64) },
      ]],
      ["duplicate remote id", [
        { localProjectId: "local-a", remoteProjectId: "remote", evidenceSha256: "a".repeat(64) },
        { localProjectId: "local-b", remoteProjectId: "remote", evidenceSha256: "b".repeat(64) },
      ]],
    ];
    for (const [label, projects] of invalidProjects) {
      const home = makeHome();
      const fake = makeDriver(material());
      await expect(coordinator(home, fake.driver).prepare({ ...valid, projects: projects as never }), label)
        .rejects.toMatchObject({ reason: "invalid-input" });
    }

    const sorted = makeHome();
    const sortedDriver = makeDriver(material());
    const prepared = await coordinator(sorted, sortedDriver.driver).prepare({
      ...valid,
      projects: [
        { localProjectId: "z", remoteProjectId: "remote-z", evidenceSha256: "b".repeat(64) },
        { localProjectId: "a", remoteProjectId: "remote-a", evidenceSha256: "c".repeat(64) },
      ],
    });
    expect(prepared.projects.map(({ localProjectId }) => localProjectId)).toEqual(["a", "z"]);
  });

  it("rejects every unsafe recovery-file boundary and project length boundary", async () => {
    const valid = inputFor(material());
    const invalidFiles: readonly [string, unknown][] = [
      ["non-byte content", { ...recoveryFile("x"), content: "x" }],
      ["oversized content", { ...recoveryFile("x"), content: Buffer.alloc(4 * 1024 * 1024 + 1) }],
      ["negative mode", { ...recoveryFile("x"), mode: -1 }],
      ["oversized mode", { ...recoveryFile("x"), mode: 0o10000 }],
      ["non-private mode", { ...recoveryFile("x"), mode: 0o644 }],
      ["fractional uid", { ...recoveryFile("x"), uid: 1.5 }],
      ["unsafe uid", { ...recoveryFile("x"), uid: Number.MAX_SAFE_INTEGER + 1 }],
      ["fractional gid", { ...recoveryFile("x"), gid: 1.5 }],
      ["unsafe gid", { ...recoveryFile("x"), gid: Number.MAX_SAFE_INTEGER + 1 }],
    ];
    for (const [label, file] of invalidFiles) {
      const home = makeHome();
      const fake = makeDriver(material());
      await expect(coordinator(home, fake.driver).prepare({
        ...valid,
        material: { ...valid.material, source: { ...valid.material.source, config: file as never } },
      }), label).rejects.toMatchObject({ reason: "invalid-input" });
    }

    for (const [label, projects] of [
      ["long local", [{ localProjectId: "l".repeat(257), remoteProjectId: "remote", evidenceSha256: "a".repeat(64) }]],
      ["long remote", [{ localProjectId: "local", remoteProjectId: "r".repeat(257), evidenceSha256: "a".repeat(64) }]],
    ] as const) {
      const home = makeHome();
      const fake = makeDriver(material());
      await expect(coordinator(home, fake.driver).prepare({ ...valid, projects: projects as never }), label)
        .rejects.toMatchObject({ reason: "invalid-input" });
    }
  });

  it("returns null for an empty recovery scan and fails closed without a journal", async () => {
    const home = makeHome();
    const fake = makeDriver(material());
    await expect(coordinator(home, fake.driver).recoverPending()).resolves.toBeNull();
    await expect(coordinator(home, fake.driver).resume()).rejects.toMatchObject({
      reason: "publication-evidence-missing",
    });
    await expect(coordinator(home, fake.driver).abort()).rejects.toMatchObject({
      reason: "publication-evidence-missing",
    });
  });

  it("fails closed for missing, replaced, and invalid publication roots", async () => {
    const missingHome = mkdtempSync(join(tmpdir(), "lcm-backend-publication-no-root-"));
    roots.push(missingHome);
    const missingFake = makeDriver(material());
    await expect(coordinator(missingHome, missingFake.driver).prepare(inputFor(material())))
      .rejects.toMatchObject({ reason: "unsafe-storage" });
    expect(readBackendPublicationJournal(missingHome)).toBeNull();

    const fileHome = makeHome();
    writeFileSync(join(fileHome, ".lcm", "backend-publication"), "not a directory", { mode: 0o600 });
    expect(() => readBackendPublicationJournal(fileHome)).toThrow("cannot be opened");
    await expect(coordinator(fileHome, makeDriver(material()).driver).prepare(inputFor(material())))
      .rejects.toMatchObject({ reason: "unsafe-storage" });

    const invalidJournalHome = makeHome();
    const invalidDirectory = backendPublicationDirectory(invalidJournalHome);
    mkdirSync(invalidDirectory, { mode: 0o700 });
    mkdirSync(join(invalidDirectory, "journal.json"), { mode: 0o700 });
    expect(() => readBackendPublicationJournal(invalidJournalHome)).toThrow("cannot be read");

    const mkdirFailureHome = makeHome();
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalMkdir = nodeFs.mkdirSync;
    const mkdirFailure = Object.assign(new Error("mkdir denied"), { code: "EACCES" });
    try {
      nodeFs.mkdirSync = ((path: string, options?: unknown) => {
        if (path === backendPublicationDirectory(mkdirFailureHome)) throw mkdirFailure;
        return (originalMkdir as (path: string, options?: unknown) => unknown)(path, options);
      });
      syncBuiltinESMExports();
      await expect(coordinator(mkdirFailureHome, makeDriver(material()).driver).prepare(inputFor(material())))
        .rejects.toMatchObject({ reason: "unsafe-storage" });
    } finally {
      nodeFs.mkdirSync = originalMkdir;
      syncBuiltinESMExports();
    }
  });

  it("detects journal races before initial and conditional writes", async () => {
    const occupied = await preparedFixture();
    const occupiedContent = readFileSync(backendPublicationJournalPath(occupied.home));
    const home = makeHome();
    const fake = makeDriver(material());
    await expect(coordinator(home, fake.driver, (event, path) => {
      if (event === "before-journal-read") writeFileSync(path, occupiedContent, { mode: 0o600 });
    }).prepare(inputFor(material()))).rejects.toMatchObject({ reason: "unresolved-publication" });

    const conditional = await preparedFixture();
    const journalPath = backendPublicationJournalPath(conditional.home);
    const observer = (event: string): void => {
      if (event === "after-journal-write" && readBackendPublicationJournal(conditional.home)?.phase === "acquiring") {
        rmSync(journalPath);
      }
    };
    await expect(coordinator(conditional.home, conditional.fake.driver, observer).resume())
      .rejects.toMatchObject({ reason: "unexpected-state" });

    const malformed = await preparedFixture();
    await expect(coordinator(malformed.home, malformed.fake.driver, (event, path) => {
      if (event === "before-journal-read") writeFileSync(path, "{", { mode: 0o600 });
    }).resume()).rejects.toMatchObject({ reason: "malformed-journal" });

    const historyHome = makeHome();
    const historyInput = material();
    const historyFirst = makeDriver(historyInput);
    await coordinator(historyHome, historyFirst.driver).prepare(inputFor(historyInput));
    await coordinator(historyHome, historyFirst.driver).resume();
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalMkdir = nodeFs.mkdirSync;
    const historyPath = join(backendPublicationDirectory(historyHome), "history");
    const historyFailure = Object.assign(new Error("history mkdir denied"), { code: "EACCES" });
    try {
      nodeFs.mkdirSync = ((path: string, options?: unknown) => {
        if (path === historyPath) throw historyFailure;
        return (originalMkdir as (path: string, options?: unknown) => unknown)(path, options);
      });
      syncBuiltinESMExports();
      await expect(coordinator(historyHome, makeDriver(historyInput).driver).prepare({
        ...inputFor(historyInput),
        publicationId: "publication-2",
      })).rejects.toThrow("history mkdir denied");
    } finally {
      nodeFs.mkdirSync = originalMkdir;
      syncBuiltinESMExports();
    }
  });

  it("aborts pending work through the recovery disposition option", async () => {
    const { home, fake } = await preparedFixture();
    await expect(coordinator(home, fake.driver).recoverPending({ disposition: "abort" }))
      .resolves.toMatchObject({ phase: "aborted" });

    const noUidHome = makeHome();
    const noUidInput = material();
    const noUidFake = makeDriver(noUidInput);
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
      await coordinator(noUidHome, noUidFake.driver).prepare(inputFor(noUidInput));
      await expect(coordinator(noUidHome, noUidFake.driver).recoverPending({ disposition: "abort" }))
        .resolves.toMatchObject({ phase: "aborted" });
    } finally {
      if (descriptor === undefined) delete (process as { getuid?: unknown }).getuid;
      else Object.defineProperty(process, "getuid", descriptor);
    }
  });

  it("fails closed for malformed authenticated journal envelopes", async () => {
    const { home } = await preparedFixture();
    writeFileSync(backendPublicationJournalPath(home), "{", { mode: 0o600 });
    let thrown: unknown;
    try {
      readBackendPublicationJournal(home);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ reason: "malformed-journal" });

    const nonObject = await preparedFixture();
    writeFileSync(backendPublicationJournalPath(nonObject.home), "[]\n", { mode: 0o600 });
    expect(() => readBackendPublicationJournal(nonObject.home)).toThrow("not an object");

    await expectJournalReadFailure((journal) => ({ ...journal, extra: true }));
    const checksumMalformed = await preparedFixture();
    const checksumValue = JSON.parse(readFileSync(backendPublicationJournalPath(checksumMalformed.home), "utf8")) as Record<string, unknown>;
    checksumValue.checksumSha256 = "bad";
    writeFileSync(backendPublicationJournalPath(checksumMalformed.home), `${JSON.stringify(checksumValue)}\n`, { mode: 0o600 });
    expect(() => readBackendPublicationJournal(checksumMalformed.home)).toThrow("checksum is malformed");

    const checksumMismatch = await preparedFixture();
    const mismatchValue = JSON.parse(readFileSync(backendPublicationJournalPath(checksumMismatch.home), "utf8")) as Record<string, unknown>;
    mismatchValue.updatedAt = "2026-08-06T12:00:01.000Z";
    writeFileSync(backendPublicationJournalPath(checksumMismatch.home), `${JSON.stringify(mismatchValue)}\n`, { mode: 0o600 });
    let checksumError: unknown;
    try {
      readBackendPublicationJournal(checksumMismatch.home);
    } catch (error) {
      checksumError = error;
    }
    expect(checksumError).toMatchObject({ reason: "checksum-mismatch" });
  });

  it("fails closed for malformed recovery-material envelopes and fields", async () => {
    await expectMaterialReadFailure("{");
    await expectMaterialReadFailure("[]");
    await expectMaterialReadFailure(JSON.stringify({ version: 2 }));
    await expectMaterialReadFailure(JSON.stringify({
      version: 1,
      publicationId: "other",
      source: {},
      target: {},
    }));
    await expectMaterialReadFailure(JSON.stringify({
      version: 1,
      publicationId: "publication-1",
      source: null,
      target: {},
    }));
    await expectMaterialReadFailure(JSON.stringify({
      version: 1,
      publicationId: "publication-1",
      source: { config: {}, projectMap: {} },
      target: { config: {}, projectMap: {} },
    }));

    const envelope = {
      version: 1,
      publicationId: "publication-1",
      source: { config: { presence: "absent" }, projectMap: { presence: "absent" } },
      target: { config: { presence: "absent" }, projectMap: { presence: "absent" } },
    };
    await expectMaterialReadFailure(JSON.stringify({
      ...envelope,
      source: { config: { presence: "absent", extra: true }, projectMap: envelope.source.projectMap },
    }));
    await expectMaterialReadFailure(JSON.stringify({
      ...envelope,
      source: { config: null, projectMap: envelope.source.projectMap },
    }));

    const present = {
      contentBase64: "",
      mode: 0o600,
      uid: 0,
      gid: 0,
      nlink: "1",
      dev: "1",
      ino: "2",
      parentDev: "3",
      parentIno: "4",
      presence: "present",
    };
    for (const [label, value, reason] of [
      ["missing content", { mode: 0o600, uid: 0, gid: 0, presence: "present" }, "malformed-journal"],
      ["wrong presence", { ...present, presence: "other" }, "malformed-journal"],
      ["wrong base64 type", { ...present, contentBase64: 1 }, "malformed-journal"],
      ["fractional mode", { ...present, mode: 1.5 }, "malformed-journal"],
      ["fractional uid", { ...present, uid: 1.5 }, "malformed-journal"],
      ["fractional gid", { ...present, gid: 1.5 }, "malformed-journal"],
      ["empty decoded content", present, "invalid-input"],
    ] as const) {
      await expectMaterialReadFailure(JSON.stringify({
        ...envelope,
        source: { config: value, projectMap: envelope.source.projectMap },
      }), reason as BackendPublicationJournalError["reason"])
        .catch((error) => { throw new Error(`${label}: ${String(error)}`); });
    }
  });

  it("requires the deterministic recovery-material pathname during authentication", async () => {
    const { home, fake } = await preparedFixture();
    rewriteJournal(home, (journal) => ({
      ...journal,
      recoveryReference: {
        relativePath: "other-publication.material",
        sealSha256: "a".repeat(64),
        byteLength: 1,
      },
    }));
    await expect(coordinator(home, fake.driver).resume()).rejects.toMatchObject({ reason: "malformed-journal" });
  });

  describe("rejects malformed journal fields, witnesses, references, fences, and projects", () => {
    it("reports malformed source state", async () => {
      const explicit = await preparedFixture();
      rewriteJournal(explicit.home, (journal) => ({ ...journal, sourceState: null }));
      expect(() => readBackendPublicationJournal(explicit.home)).toThrow("source state is malformed");
    });

    const malformedCases: readonly [string, (journal: Record<string, unknown>) => Record<string, unknown>][] = [
      ["invalid fields", (journal) => ({ ...journal, version: 1 })],
      ["invalid phase", (journal) => ({ ...journal, phase: "unknown" })],
      ["invalid source backend", (journal) => ({ ...journal, sourceBackend: "redis" })],
      ["invalid target backend", (journal) => ({ ...journal, targetBackend: "redis" })],
      ["same backend", (journal) => ({ ...journal, targetBackend: journal.sourceBackend })],
      ["invalid timestamp", (journal) => ({ ...journal, createdAt: "invalid" })],
      ["invalid hash", (journal) => ({ ...journal, expectedConfigSha256: "bad" })],
      ["invalid projects", (journal) => ({ ...journal, projects: {} })],
      ["invalid source state", (journal) => ({ ...journal, sourceState: null })],
      ["invalid witness object", (journal) => ({
        ...journal,
        sourceState: { ...(journal.sourceState as Record<string, unknown>), config: null },
      })],
      ["absent witness extra field", (journal) => ({
        ...journal,
        sourceState: {
          config: {
            presence: "absent",
            rawSha256: null,
            semanticSha256: null,
            byteLength: 0,
            mode: null,
            uid: null,
            gid: null,
            nlink: null,
            dev: null,
            ino: null,
            parentDev: null,
            parentIno: null,
            extra: true,
          },
          projectMap: (journal.sourceState as { projectMap: unknown }).projectMap,
        },
      })],
      ["absent witness value", (journal) => ({
        ...journal,
        sourceState: {
          config: {
            presence: "absent",
            rawSha256: "bad",
            semanticSha256: null,
            byteLength: 0,
            mode: null,
            uid: null,
            gid: null,
            nlink: null,
            dev: null,
            ino: null,
            parentDev: null,
            parentIno: null,
          },
          projectMap: (journal.sourceState as { projectMap: unknown }).projectMap,
        },
      })],
      ["invalid presence", (journal) => ({
        ...journal,
        sourceState: { ...(journal.sourceState as Record<string, unknown>), config: { presence: "other" } },
      })],
      ["present witness extra field", (journal) => ({
        ...journal,
        sourceState: {
          ...(journal.sourceState as Record<string, unknown>),
          config: { ...((journal.sourceState as { config: Record<string, unknown> }).config), extra: true },
        },
      })],
      ["present witness malformed", (journal) => ({
        ...journal,
        sourceState: {
          ...(journal.sourceState as Record<string, unknown>),
          config: { ...((journal.sourceState as { config: Record<string, unknown> }).config), rawSha256: "bad" },
        },
      })],
      ["present semantic hash malformed", (journal) => ({
        ...journal,
        sourceState: {
          ...(journal.sourceState as Record<string, unknown>),
          config: { ...((journal.sourceState as { config: Record<string, unknown> }).config), semanticSha256: "bad" },
        },
      })],
      ["present byte length malformed", (journal) => ({
        ...journal,
        sourceState: {
          ...(journal.sourceState as Record<string, unknown>),
          config: { ...((journal.sourceState as { config: Record<string, unknown> }).config), byteLength: 0 },
        },
      })],
      ["present mode malformed", (journal) => ({
        ...journal,
        sourceState: {
          ...(journal.sourceState as Record<string, unknown>),
          config: { ...((journal.sourceState as { config: Record<string, unknown> }).config), mode: -1 },
        },
      })],
      ["present uid malformed", (journal) => ({
        ...journal,
        sourceState: {
          ...(journal.sourceState as Record<string, unknown>),
          config: { ...((journal.sourceState as { config: Record<string, unknown> }).config), uid: -1 },
        },
      })],
      ["present gid malformed", (journal) => ({
        ...journal,
        sourceState: {
          ...(journal.sourceState as Record<string, unknown>),
          config: { ...((journal.sourceState as { config: Record<string, unknown> }).config), gid: -1 },
        },
      })],
      ["present nlink malformed", (journal) => ({
        ...journal,
        sourceState: {
          ...(journal.sourceState as Record<string, unknown>),
          config: { ...((journal.sourceState as { config: Record<string, unknown> }).config), nlink: "bad" },
        },
      })],
      ["present dev malformed", (journal) => ({
        ...journal,
        sourceState: {
          ...(journal.sourceState as Record<string, unknown>),
          config: { ...((journal.sourceState as { config: Record<string, unknown> }).config), dev: "bad" },
        },
      })],
      ["present ino malformed", (journal) => ({
        ...journal,
        sourceState: {
          ...(journal.sourceState as Record<string, unknown>),
          config: { ...((journal.sourceState as { config: Record<string, unknown> }).config), ino: "bad" },
        },
      })],
      ["present parent dev malformed", (journal) => ({
        ...journal,
        sourceState: {
          ...(journal.sourceState as Record<string, unknown>),
          config: { ...((journal.sourceState as { config: Record<string, unknown> }).config), parentDev: "bad" },
        },
      })],
      ["present parent ino malformed", (journal) => ({
        ...journal,
        sourceState: {
          ...(journal.sourceState as Record<string, unknown>),
          config: { ...((journal.sourceState as { config: Record<string, unknown> }).config), parentIno: "bad" },
        },
      })],
      ["invalid reference", (journal) => ({ ...journal, recoveryReference: { relativePath: "bad" } })],
      ["reference empty length", (journal) => ({
        ...journal,
        recoveryReference: { relativePath: "publication-1.material", sealSha256: "a".repeat(64), byteLength: 0 },
      })],
      ["reference oversized length", (journal) => ({
        ...journal,
        recoveryReference: { relativePath: "publication-1.material", sealSha256: "a".repeat(64), byteLength: 8 * 1024 * 1024 + 1 },
      })],
      ["invalid fence", (journal) => ({
        ...journal,
        projects: [{
          ...((journal.projects as Record<string, unknown>[])[0]),
          fence: { bad: true },
        }],
      })],
      ["invalid project", (journal) => ({ ...journal, projects: [{ localProjectId: "only-local" }] })],
      ["project invalid local", (journal) => ({
        ...journal,
        projects: [{
          ...((journal.projects as Record<string, unknown>[])[0]),
          localProjectId: 1,
        }],
      })],
      ["project invalid remote", (journal) => ({
        ...journal,
        projects: [{
          ...((journal.projects as Record<string, unknown>[])[0]),
          remoteProjectId: 1,
        }],
      })],
      ["project invalid evidence", (journal) => ({
        ...journal,
        projects: [{
          ...((journal.projects as Record<string, unknown>[])[0]),
          evidenceSha256: "bad",
        }],
      })],
      ["project invalid fence value", (journal) => ({
        ...journal,
        projects: [{
          ...((journal.projects as Record<string, unknown>[])[0]),
          fence: "bad",
        }],
      })],
    ];
    it.each(malformedCases)("%s", async (_label, mutate) => {
      await expectJournalReadFailure(mutate);
    });
  });

  it("rejects every malformed persisted fence field", async () => {
    const baseFence = {
      projectId: "remote-project",
      machineId: "machine-1",
      publicationId: "publication-1",
      targetBackend: "postgresql",
      evidenceSha256: "a".repeat(64),
      fencingToken: "1",
      acquiredAt: "2026-08-06T12:00:00.000Z",
      renewedAt: "2026-08-06T12:00:00.000Z",
      expiresAt: "2999-08-06T12:00:00.000Z",
      releasedAt: null,
      databaseExpired: false,
    };
    const malformed: readonly [string, Record<string, unknown>][] = [
      ["project id", { projectId: 1 }],
      ["machine id", { machineId: 1 }],
      ["publication id", { publicationId: 1 }],
      ["target backend", { targetBackend: "redis" }],
      ["evidence", { evidenceSha256: "bad" }],
      ["fencing token", { fencingToken: "bad" }],
      ["acquired timestamp", { acquiredAt: "bad" }],
      ["renewed timestamp", { renewedAt: "bad" }],
      ["expiry timestamp", { expiresAt: "bad" }],
      ["released type", { releasedAt: 1 }],
      ["released timestamp", { releasedAt: "bad" }],
      ["database expiry", { databaseExpired: "false" }],
    ];
    for (const [label, change] of malformed) {
      await expectJournalReadFailure((journal) => ({
        ...journal,
        projects: [{
          ...((journal.projects as Record<string, unknown>[])[0]),
          fence: { ...baseFence, ...change },
        }],
      })).catch((error) => { throw new Error(`${label}: ${String(error)}`); });
    }
  });

  it("rejects unsorted, duplicate, and empty project journal records", async () => {
    await expectJournalReadFailure((journal) => ({
      ...journal,
      projects: [
        ...(journal.projects as Record<string, unknown>[]),
        { ...(journal.projects as Record<string, unknown>[])[0], localProjectId: "" },
      ],
    }));

    const duplicateLocal = await preparedFixture();
    rewriteJournal(duplicateLocal.home, (journal) => ({
      ...journal,
      projects: [
        ...(journal.projects as Record<string, unknown>[]),
        { ...(journal.projects as Record<string, unknown>[])[0], remoteProjectId: "other" },
      ],
    }));
    expect(() => readBackendPublicationJournal(duplicateLocal.home)).toThrow("canonically sorted");

    const duplicateRemote = await preparedFixture();
    rewriteJournal(duplicateRemote.home, (journal) => ({
      ...journal,
      projects: [
        ...(journal.projects as Record<string, unknown>[]),
        { ...(journal.projects as Record<string, unknown>[])[0], localProjectId: "other" },
      ],
    }));
    expect(() => readBackendPublicationJournal(duplicateRemote.home)).toThrow("canonically sorted");
  });

  it("routes abort recovery through abort-release checkpoints after release crashes", async () => {
    for (const checkpoint of ["before-release", "after-release"] as const) {
      const home = makeHome();
      const input = material();
      const fake = makeDriver(input);
      let fence: BackendPublicationFenceRecord | null = null;
      fake.driver.acquireRemoteGuard = vi.fn(async () => {
        fence = fenceRecord();
        return fence;
      });
      fake.driver.readRemoteGuard = vi.fn(async () => fence);
      fake.driver.releaseRemoteGuard = vi.fn(async () => {
        if (fence !== null) fence = { ...fence, releasedAt: "2026-08-06T12:01:00.000Z" };
      });
      await coordinator(home, fake.driver).prepare(inputFor(input));
      await expect(coordinator(home, fake.driver, (event) => {
        if (event === "before-release") throw new Error("crash:initial-release");
      }).resume()).rejects.toThrow("crash:initial-release");
      expect(readBackendPublicationJournal(home)?.phase).toBe("releasing");

      const abortCall = checkpoint === "before-release"
        ? coordinator(home, fake.driver, (event) => {
          if (event === checkpoint) throw new Error("crash:abort-" + checkpoint);
        }).abort()
        : coordinator(home, fake.driver, (event) => {
          if (event === checkpoint) throw new Error("crash:abort-" + checkpoint);
        }).recoverPending({ disposition: "abort" });
      await expect(abortCall).rejects.toThrow("crash:abort-" + checkpoint);
      expect(readBackendPublicationJournal(home)?.phase).toBe("abort-releasing");

      const recovered = await coordinator(home, fake.driver).abort();
      expect(recovered.phase).toBe("aborted");
      expect(fence?.releasedAt).not.toBeNull();
      expect(existsSync(join(backendPublicationDirectory(home), "publication-1.material"))).toBe(false);
    }
  });

  it("keeps abort-releasing durable until sealed material cleanup completes", async () => {
    const { home, input, fake } = await preparedFixture();
    await expect(coordinator(home, fake.driver, (event) => {
      if (
        event === "before-material-authenticate"
        && readBackendPublicationJournal(home)?.phase === "abort-releasing"
      ) throw new Error("crash:abort-cleanup");
    }).abort()).rejects.toThrow("crash:abort-cleanup");
    expect(readBackendPublicationJournal(home)?.phase).toBe("abort-releasing");
    const materialPath = join(backendPublicationDirectory(home), "publication-1.material");
    expect(existsSync(materialPath)).toBe(true);

    const aborted = await coordinator(home, fake.driver).abort();
    expect(aborted.phase).toBe("aborted");
    expect(existsSync(materialPath)).toBe(false);
    expect(fake.getState()).toEqual(sourceState(input));
  });

  it("replays abort cleanup after material deletion before the aborted checkpoint", async () => {
    const { home, input, fake } = await preparedFixture();
    const materialPath = join(backendPublicationDirectory(home), "publication-1.material");
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalUnlink = nodeFs.unlinkSync as (path: string) => void;
    const crash = Object.assign(new Error("crash:after-material-delete"), { code: "EIO" });
    let injected = false;

    await expect(withPatchedFsAsync("unlinkSync", ((candidate: string) => {
      if (!injected && candidate === materialPath) {
        injected = true;
        originalUnlink(candidate);
        throw crash;
      }
      return originalUnlink(candidate);
    }) as never, async () => coordinator(home, fake.driver).abort()))
      .rejects.toThrow("crash:after-material-delete");
    expect(readBackendPublicationJournal(home)?.phase).toBe("abort-releasing");
    expect(existsSync(materialPath)).toBe(false);

    const aborted = await coordinator(home, fake.driver).abort();
    expect(aborted.phase).toBe("aborted");
    expect(existsSync(materialPath)).toBe(false);
    await expect(coordinator(home, fake.driver).recoverPending()).resolves.toEqual(aborted);
    expect(fake.getState()).toEqual(sourceState(input));
  });

  it("fails closed when abort material is missing or tampered before cleanup", async () => {
    const missing = await preparedFixture();
    const missingPath = join(backendPublicationDirectory(missing.home), "publication-1.material");
    rmSync(missingPath);
    await expect(coordinator(missing.home, missing.fake.driver).abort()).rejects.toThrow();
    expect(readBackendPublicationJournal(missing.home)?.phase).toBe("aborting");

    const tampered = await preparedFixture();
    const tamperedPath = join(backendPublicationDirectory(tampered.home), "publication-1.material");
    writeFileSync(tamperedPath, "tampered", { mode: 0o600 });
    await expect(coordinator(tampered.home, tampered.fake.driver).abort())
      .rejects.toMatchObject({ reason: "checksum-mismatch" });
  });

  it("resumes a parked active-fence abort-releasing journal to aborted", async () => {
    const { home, input, fake, getFence } = await releasingFixture();
    await expect(coordinator(home, fake.driver, (event) => {
      if (
        event === "before-release"
        && readBackendPublicationJournal(home)?.phase === "abort-releasing"
      ) throw new Error("crash:abort-before-release-resume");
    }).abort()).rejects.toThrow("crash:abort-before-release-resume");
    expect(readBackendPublicationJournal(home)?.phase).toBe("abort-releasing");
    expect(getFence()?.releasedAt).toBeNull();
    const materialPath = join(backendPublicationDirectory(home), "publication-1.material");
    expect(existsSync(materialPath)).toBe(true);

    const recovered = await coordinator(home, fake.driver).resume();
    expect(recovered.phase).toBe("aborted");
    expect(recovered.phase).not.toBe("completed");
    expect(getFence()?.releasedAt).not.toBeNull();
    expect(existsSync(materialPath)).toBe(false);
    expect(fake.getState()).toEqual(sourceState(input));
  });

  it("recovers a parked active-fence abort-releasing journal without a disposition", async () => {
    const { home, input, fake, getFence } = await releasingFixture();
    await expect(coordinator(home, fake.driver, (event) => {
      if (
        event === "before-release"
        && readBackendPublicationJournal(home)?.phase === "abort-releasing"
      ) throw new Error("crash:abort-before-release-default-recover");
    }).abort()).rejects.toThrow("crash:abort-before-release-default-recover");
    expect(readBackendPublicationJournal(home)?.phase).toBe("abort-releasing");
    expect(getFence()?.releasedAt).toBeNull();
    const materialPath = join(backendPublicationDirectory(home), "publication-1.material");
    expect(existsSync(materialPath)).toBe(true);

    const recovered = await coordinator(home, fake.driver).recoverPending();
    expect(recovered?.phase).toBe("aborted");
    expect(recovered?.phase).not.toBe("completed");
    expect(getFence()?.releasedAt).not.toBeNull();
    expect(existsSync(materialPath)).toBe(false);
    expect(fake.getState()).toEqual(sourceState(input));
  });

  it("does not emit target completion evidence after both publishes and restores", async () => {
    const { home, input, fake, getFence } = await releasingFixture();
    const retained = vi.fn(async () => undefined);
    fake.driver.retainCompletedMaterial = retained;
    await expect(coordinator(home, fake.driver, (event) => {
      if (
        event === "before-material-authenticate"
        && readBackendPublicationJournal(home)?.phase === "abort-releasing"
      ) throw new Error("crash:abort-post-publish");
    }).abort()).rejects.toThrow("crash:abort-post-publish");
    const parked = readBackendPublicationJournal(home);
    expect(parked?.phase).toBe("abort-releasing");
    expect(parked?.sourceState).toEqual(sourceState(input));
    expect(parked?.targetState).toEqual(targetState(input));
    expect(fake.getState()).toEqual(sourceState(input));

    const recovered = await coordinator(home, fake.driver).recoverPending();
    expect(recovered?.phase).toBe("aborted");
    expect(recovered?.phase).not.toBe("completed");
    expect(recovered?.sourceState).toEqual(sourceState(input));
    expect(recovered?.targetState).toEqual(targetState(input));
    expect(fake.getState()).toEqual(sourceState(input));
    expect(getFence()?.releasedAt).not.toBeNull();
    expect(existsSync(join(backendPublicationDirectory(home), "publication-1.material"))).toBe(false);
    expect(retained).not.toHaveBeenCalled();
    expect(() => assertBackendPublicationConsumerAccess({ homeDir: home, backend: "sqlite" })).not.toThrow();
    expect(() => assertBackendPublicationConsumerAccess({ homeDir: home, backend: "postgresql" }))
      .toThrow("stored backend does not match");
  });

  it("replays an exact terminal archive and rejects a symlinked history directory", async () => {
    const home = makeHome();
    const input = material();
    const first = makeDriver(input);
    await coordinator(home, first.driver).prepare(inputFor(input));
    const completed = await coordinator(home, first.driver).resume();
    const archivePath = join(
      backendPublicationDirectory(home),
      "history",
      completed.publicationId + "." + completed.checksumSha256 + ".json",
    );
    const second = makeDriver(input);
    await expect(coordinator(home, second.driver, (event) => {
      if (event === "before-journal-write") throw new Error("crash:before-replacement-replay");
    }).prepare({
      ...inputFor(input),
      publicationId: "publication-2",
    })).rejects.toThrow("crash:before-replacement-replay");
    expect(existsSync(archivePath)).toBe(true);
    expect(readBackendPublicationJournal(home)?.phase).toBe("completed");
    await expect(coordinator(home, second.driver).prepare({
      ...inputFor(input),
      publicationId: "publication-2",
    })).resolves.toMatchObject({ phase: "prepared" });

    const errorHome = makeHome();
    const errorInput = material();
    const errorFirst = makeDriver(errorInput);
    await coordinator(errorHome, errorFirst.driver).prepare(inputFor(errorInput));
    await coordinator(errorHome, errorFirst.driver).resume();
    const errorNodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalLink = errorNodeFs.linkSync as (from: string, to: string) => void;
    const archiveLinkFailure = new Error("archive link denied");
    await expect(withPatchedFsAsync("linkSync", (() => {
      throw archiveLinkFailure;
    }) as never, async () => coordinator(errorHome, makeDriver(errorInput).driver).prepare({
      ...inputFor(errorInput),
      publicationId: "publication-2",
    }))).rejects.toThrow(archiveLinkFailure);
    errorNodeFs.linkSync = originalLink;
    expect(readBackendPublicationJournal(errorHome)?.phase).toBe("completed");
    await expect(coordinator(errorHome, makeDriver(errorInput).driver).prepare({
      ...inputFor(errorInput),
      publicationId: "publication-2",
    })).resolves.toMatchObject({ phase: "prepared" });

    const symlinkHome = makeHome();
    const symlinkInput = material();
    const symlinkFirst = makeDriver(symlinkInput);
    await coordinator(symlinkHome, symlinkFirst.driver).prepare(inputFor(symlinkInput));
    await coordinator(symlinkHome, symlinkFirst.driver).resume();
    const history = join(backendPublicationDirectory(symlinkHome), "history");
    mkdirSync(history, { mode: 0o700 });
    rmSync(history, { recursive: true });
    const victim = join(symlinkHome, "history-victim");
    mkdirSync(victim, { mode: 0o755 });
    symlinkSync(victim, history, "dir");
    await expect(coordinator(symlinkHome, makeDriver(symlinkInput).driver).prepare({
      ...inputFor(symlinkInput),
      publicationId: "publication-2",
    })).rejects.toThrow();
    expect(statSync(victim).mode & 0o777).toBe(0o755);
  });

  it("covers archive replay with missing uid evidence and rejects an unsafe archive path", async () => {
    const home = makeHome();
    const input = material();
    const first = makeDriver(input);
    await coordinator(home, first.driver).prepare(inputFor(input));
    await coordinator(home, first.driver).resume();
    const second = makeDriver(input);
    await expect(coordinator(home, second.driver, (event) => {
      if (event === "before-journal-write") throw new Error("crash:archive-replay");
    }).prepare({
      ...inputFor(input),
      publicationId: "publication-2",
    })).rejects.toThrow("crash:archive-replay");

    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
      await expect(coordinator(home, second.driver).prepare({
        ...inputFor(input),
        publicationId: "publication-2",
      })).resolves.toMatchObject({ phase: "prepared" });
    } finally {
      if (descriptor === undefined) delete (process as { getuid?: unknown }).getuid;
      else Object.defineProperty(process, "getuid", descriptor);
    }

    const unsafeHome = makeHome();
    const unsafeInput = material();
    const unsafeFirst = makeDriver(unsafeInput);
    await coordinator(unsafeHome, unsafeFirst.driver).prepare(inputFor(unsafeInput));
    const unsafeCompleted = await coordinator(unsafeHome, unsafeFirst.driver).resume();
    const unsafeHistory = join(backendPublicationDirectory(unsafeHome), "history");
    mkdirSync(unsafeHistory, { mode: 0o700 });
    mkdirSync(join(
      unsafeHistory,
      unsafeCompleted.publicationId + "." + unsafeCompleted.checksumSha256 + ".json",
    ));
    await expect(coordinator(unsafeHome, makeDriver(unsafeInput).driver).prepare({
      ...inputFor(unsafeInput),
      publicationId: "publication-2",
    })).rejects.toThrow("regular file");
  });

  it("requires exact identities for persisted state and does not match unresolved targets", async () => {
    const input = material();
    const exactSource: BackendPublicationStateWitness = {
      config: { ...sourceState(input).config, dev: "9007199254740993", ino: "9007199254740995", parentDev: "7", parentIno: "11" },
      projectMap: { ...sourceState(input).projectMap, dev: "9007199254740993", ino: "9007199254740997", parentDev: "7", parentIno: "11" },
    };
    const malformedHome = makeHome();
    const malformed = makeDriver(input);
    malformed.driver.observeLocalState = vi.fn(async () => exactSource);
    await coordinator(malformedHome, malformed.driver).prepare(inputFor(input));
    rewriteJournal(malformedHome, (journal) => ({
      ...journal,
      sourceState: {
        ...(journal.sourceState as Record<string, unknown>),
        config: { ...((journal.sourceState as Record<string, unknown>).config as Record<string, unknown>), dev: null },
      },
    }));
    expect(() => readBackendPublicationJournal(malformedHome)).toThrow("present witness is malformed");

    const matchingHome = makeHome();
    const matching = makeDriver(input);
    matching.driver.observeLocalState = vi.fn(async () => exactSource);
    await coordinator(matchingHome, matching.driver).prepare(inputFor(input));
    matching.driver.observeLocalState = vi.fn(async () => ({
      config: { ...targetState(input).config, dev: "9007199254740993", ino: "9007199254740995", parentDev: "7", parentIno: "11" },
      projectMap: { ...targetState(input).projectMap, dev: "9007199254740993", ino: "9007199254740997", parentDev: "7", parentIno: "11" },
    }));
    await expect(coordinator(matchingHome, matching.driver).resume()).rejects.toMatchObject({ reason: "unexpected-state" });
  });

  it("admits lock-free SQLite config reads without publication evidence", () => {
    const home = makeHome();
    const configPath = join(home, ".lcm", "config.json");
    writeFileSync(configPath, "{}", { mode: 0o600 });
    const witness = configReadWitness(configPath);

    expect(() => assertBackendPublicationConfigReadAccess(configPath, "sqlite", witness)).not.toThrow();
    expect(() => assertBackendPublicationConfigReadAccess(configPath, "postgresql", witness))
      .toThrowError(expect.objectContaining({ reason: "publication-evidence-missing" }));

    const unscopedPath = join(home, "config.json");
    writeFileSync(unscopedPath, "{}", { mode: 0o600 });
    expect(() => assertBackendPublicationConfigReadAccess(
      unscopedPath,
      "sqlite",
      configReadWitness(unscopedPath),
    )).not.toThrow();
  });

  it("rejects lock-free reads when the publication directory exists without a journal", () => {
    const home = makeHome();
    const configPath = join(home, ".lcm", "config.json");
    writeFileSync(configPath, "{}", { mode: 0o600 });
    mkdirSync(backendPublicationDirectory(home), { mode: 0o700 });

    expect(() => assertBackendPublicationConfigReadAccess(
      configPath,
      "sqlite",
      configReadWitness(configPath),
    )).toThrowError(expect.objectContaining({ reason: "publication-evidence-missing" }));
  });

  it("rejects SQLite admission when publication directory authentication is interrupted", async () => {
    const home = makeHome();
    const configPath = join(home, ".lcm", "config.json");
    const publicationDirectory = backendPublicationDirectory(home);
    writeFileSync(configPath, "{}", { mode: 0o600 });
    mkdirSync(publicationDirectory, { mode: 0o700 });
    const witness = configReadWitness(configPath);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalRealpath = nodeFs.realpathSync as (...args: unknown[]) => unknown;
    let injected = false;
    let admissionError: unknown;

    await withPatchedFsAsync("realpathSync", ((path: string, ...args: unknown[]) => {
      if (path === publicationDirectory && !injected) {
        injected = true;
        rmSync(publicationDirectory, { recursive: true });
      }
      return originalRealpath(path, ...args);
    }) as never, async () => {
      try {
        assertBackendPublicationConfigReadAccess(configPath, "sqlite", witness);
      } catch (error) {
        admissionError = error;
      }
    });

    expect(injected).toBe(true);
    expect(admissionError).toBeInstanceOf(BackendPublicationJournalError);
    expect(admissionError).toMatchObject({ reason: "unsafe-storage" });
  });

  it.each(["removed", "rebound"] as const)(
    "retains the authenticated publication directory when it is %s between journal read and evidence enumeration",
    (replacement) => {
      const home = makeHome();
      const configPath = join(home, ".lcm", "config.json");
      const publicationDirectory = backendPublicationDirectory(home);
      writeFileSync(configPath, "{}", { mode: 0o600 });
      mkdirSync(publicationDirectory, { mode: 0o700 });
      const witness = configReadWitness(configPath);
      const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
      const originalOpen = nodeFs.openSync as (...args: unknown[]) => number;
      const originalReaddir = nodeFs.readdirSync as (...args: unknown[]) => unknown;
      let publicationDirectoryOpens = 0;
      let injected = false;
      const replacePublicationDirectory = (): void => {
        if (injected) return;
        injected = true;
        rmSync(publicationDirectory, { recursive: true });
        if (replacement === "rebound") mkdirSync(publicationDirectory, { mode: 0o700 });
      };

      try {
        // The current implementation reopens before enumeration; a corrected
        // implementation may enumerate through the retained handle instead.
        // Inject at whichever of those stable boundaries it reaches first.
        nodeFs.openSync = ((path: string, ...args: unknown[]) => {
          if (path === publicationDirectory) {
            publicationDirectoryOpens += 1;
            if (publicationDirectoryOpens > 1) replacePublicationDirectory();
          }
          return originalOpen(path, ...args);
        }) as never;
        nodeFs.readdirSync = ((...args: unknown[]) => {
          replacePublicationDirectory();
          return originalReaddir(...args);
        }) as never;
        syncBuiltinESMExports();

        expect(() => assertBackendPublicationConfigReadAccess(
          configPath,
          "sqlite",
          witness,
        )).toThrowError(expect.objectContaining({
          name: "BackendPublicationJournalError",
          reason: "unsafe-storage",
        }));
        expect(injected).toBe(true);
      } finally {
        nodeFs.openSync = originalOpen;
        nodeFs.readdirSync = originalReaddir;
        syncBuiltinESMExports();
      }
    },
  );

  it("binds a present journal to the retained publication directory identity", async () => {
    const { home } = await preparedFixture();
    const publicationDirectory = backendPublicationDirectory(home);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalStat = nodeFs.statSync as (
      path: string,
      options?: { bigint?: boolean },
    ) => { dev: bigint; ino: bigint; [key: string]: unknown };
    let publicationDirectoryStats = 0;

    await withPatchedFsAsync("statSync", ((path: string, options?: { bigint?: boolean }) => {
      const observed = originalStat(path, options);
      if (path === publicationDirectory && options?.bigint === true) {
        publicationDirectoryStats += 1;
        if (publicationDirectoryStats === 3) return { ...observed, dev: observed.dev + 1n };
      }
      return observed;
    }) as never, async () => {
      expect(() => readBackendPublicationJournal(home)).toThrowError(expect.objectContaining({
        name: "BackendPublicationJournalError",
        reason: "unsafe-storage",
      }));
    });
  });

  it("normalizes retained directory revalidation failures after a journal read", async () => {
    const { home } = await preparedFixture();
    const publicationDirectory = backendPublicationDirectory(home);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalStat = nodeFs.statSync as (
      path: string,
      options?: { bigint?: boolean },
    ) => { dev: bigint; ino: bigint; [key: string]: unknown };
    let publicationDirectoryStats = 0;

    await withPatchedFsAsync("statSync", ((path: string, options?: { bigint?: boolean }) => {
      const observed = originalStat(path, options);
      if (path === publicationDirectory && options?.bigint === true) {
        publicationDirectoryStats += 1;
        if (publicationDirectoryStats === 4) return { ...observed, dev: observed.dev + 1n };
      }
      return observed;
    }) as never, async () => {
      expect(() => readBackendPublicationJournal(home)).toThrowError(expect.objectContaining({
        name: "BackendPublicationJournalError",
        reason: "unsafe-storage",
        message: expect.stringContaining("backend publication directory changed during journal read"),
      }));
    });
  });

  it("binds terminal material to the journal directory for lock-free config reads", async () => {
    const { home, fake } = await preparedFixture();
    await coordinator(home, fake.driver).resume();
    const configPath = join(home, ".lcm", "config.json");
    const witness = configReadWitness(configPath);
    let admitted = false;

    const observed = await withTemporaryReboundPublicationMaterial(home, () => {
      assertBackendPublicationConfigReadAccess(configPath, "postgresql", witness);
      admitted = true;
    });

    expect(observed.injected).toBe(true);
    expect(observed.restored).toBe(true);
    expect(admitted).toBe(false);
    expect(observed.error).toBeInstanceOf(BackendPublicationJournalError);
    expect(observed.error).toMatchObject({ reason: "unsafe-storage" });
  });

  it("binds terminal material to the journal directory for locked consumers", async () => {
    const { home, fake } = await preparedFixture();
    await coordinator(home, fake.driver).resume();
    let callbackRan = false;

    const observed = await withTemporaryReboundPublicationMaterial(home, () => {
      withBackendPublicationConsumerLock(home, () => {
        callbackRan = true;
      });
    });

    expect(observed.injected).toBe(true);
    expect(observed.restored).toBe(true);
    expect(callbackRan).toBe(false);
    expect(observed.error).toBeInstanceOf(BackendPublicationJournalError);
    expect(observed.error).toMatchObject({ reason: "unsafe-storage" });
  });

  it("normalizes retained directory drift during terminal material authentication", async () => {
    const { home, fake } = await preparedFixture();
    await coordinator(home, fake.driver).resume();
    const configPath = join(home, ".lcm", "config.json");
    const witness = configReadWitness(configPath);
    const publicationDirectory = backendPublicationDirectory(home);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalStat = nodeFs.statSync as (
      path: string,
      options?: { bigint?: boolean },
    ) => { dev: bigint; ino: bigint; [key: string]: unknown };
    let publicationDirectoryStats = 0;

    await withPatchedFsAsync("statSync", ((path: string, options?: { bigint?: boolean }) => {
      const observed = originalStat(path, options);
      if (path === publicationDirectory && options?.bigint === true) {
        publicationDirectoryStats += 1;
        if (publicationDirectoryStats === 5) return { ...observed, dev: observed.dev + 1n };
      }
      return observed;
    }) as never, async () => {
      expect(() => assertBackendPublicationConfigReadAccess(
        configPath,
        "postgresql",
        witness,
      )).toThrowError(expect.objectContaining({
        name: "BackendPublicationJournalError",
        reason: "unsafe-storage",
        message: expect.stringContaining("changed during material authentication"),
      }));
    });
    expect(publicationDirectoryStats).toBeGreaterThanOrEqual(5);
  });

  it("validates lock-free reads against terminal evidence and the exact config witness", async () => {
    const { home, fake } = await preparedFixture();
    await coordinator(home, fake.driver).resume();
    const configPath = join(home, ".lcm", "config.json");
    const witness = configReadWitness(configPath);

    expect(() => assertBackendPublicationConfigReadAccess(configPath, "postgresql", witness)).not.toThrow();
    expect(() => assertBackendPublicationConfigReadAccess(configPath, "sqlite", witness))
      .toThrowError(expect.objectContaining({ reason: "backend-mismatch" }));

    writeFileSync(configPath, "{}", { mode: 0o600 });
    expect(() => assertBackendPublicationConfigReadAccess(configPath, "postgresql", witness))
      .toThrowError(expect.objectContaining({ reason: "unexpected-state" }));
  });

  it("admits the source backend through an aborted terminal publication journal", async () => {
    const { home, fake } = await preparedFixture();
    await coordinator(home, fake.driver).abort();
    const configPath = join(home, ".lcm", "config.json");

    expect(() => assertBackendPublicationConfigReadAccess(
      configPath,
      "sqlite",
      configReadWitness(configPath),
    )).not.toThrow();
  });

});

describe("revocable mutation permits", () => {
  it("retains and authenticates an injected owner policy for a normal HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-home-lock-topology-"));
    roots.push(home);
    chmodSync(home, 0o755);
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (expectedUid === undefined) throw new Error("HOME lock topology tests require process.getuid");

    const topology = openHomeLockTopology(home, expectedUid);
    try {
      expect(() => assertHomeLockTopology(topology)).not.toThrow();
      restoreHomeLockTopologyMode(topology);
      expect(statSync(home).mode & 0o7777).toBe(0o755);
    } finally {
      closeHomeLockTopology(topology);
    }

    expect(() => openHomeLockTopology(home, expectedUid + 1)).toThrow("trusted");

    const defaultTopology = openHomeLockTopology();
    try {
      expect(defaultTopology.homePath).toBe(resolve(homedir()));
      expect(() => assertHomeLockTopology(defaultTopology)).not.toThrow();
    } finally {
      closeHomeLockTopology(defaultTopology);
    }
  });

  it("authenticates a normal 0755 HOME without tightening it for first-boot admission", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-consumer-normal-home-"));
    roots.push(home);
    chmodSync(home, 0o755);

    withBackendPublicationConsumerLock(home, () => {
      expect(statSync(home).mode & 0o7777).toBe(0o755);
    });
    expect(statSync(home).mode & 0o7777).toBe(0o755);

    expect(() => withBackendPublicationConsumerLock(home, () => {
      throw new Error("callback failed");
    })).toThrow("callback failed");
    expect(statSync(home).mode & 0o7777).toBe(0o755);
  });

  it("keeps the backend publication lock valid across unrelated sibling entry churn", () => {
    const parent = mkdtempSync(join(tmpdir(), "lcm-consumer-ctime-churn-parent-"));
    const home = join(parent, "home");
    mkdirSync(home, { mode: 0o755 });
    roots.push(parent);

    const beforeParent = statSync(parent, { bigint: true });
    const beforeHome = statSync(home, { bigint: true });
    const parentCanonical = resolve(realpathSync(parent));
    const homeCanonical = resolve(realpathSync(home));

    withBackendPublicationConsumerLock(home, () => {
      const sibling = join(parent, "unrelated-sibling");
      mkdirSync(sibling, { mode: 0o700 });
      rmSync(sibling, { recursive: true, force: true });

      const afterParent = statSync(parent, { bigint: true });
      const afterHome = statSync(home, { bigint: true });
      expect(afterParent.dev).toBe(beforeParent.dev);
      expect(afterParent.ino).toBe(beforeParent.ino);
      expect(afterParent.uid).toBe(beforeParent.uid);
      expect(afterParent.gid).toBe(beforeParent.gid);
      expect(Number(afterParent.mode & 0o7777n)).toBe(Number(beforeParent.mode & 0o7777n));
      expect(afterHome.dev).toBe(beforeHome.dev);
      expect(afterHome.ino).toBe(beforeHome.ino);
      expect(afterHome.uid).toBe(beforeHome.uid);
      expect(afterHome.gid).toBe(beforeHome.gid);
      expect(resolve(realpathSync(parent))).toBe(parentCanonical);
      expect(resolve(realpathSync(home))).toBe(homeCanonical);
    });

    const topology = openHomeLockTopology(home);
    try {
      expect(() => assertHomeLockTopology({
        ...topology,
        parentMode: topology.parentMode ^ 0o001,
      })).toThrow("topology changed during validation");
    } finally {
      closeHomeLockTopology(topology);
    }
  });

  it("rejects unsafe or non-canonical HOME lock parents", () => {
    const unsafeParent = mkdtempSync(join(tmpdir(), "lcm-consumer-unsafe-parent-"));
    roots.push(unsafeParent);
    chmodSync(unsafeParent, 0o755);
    const unsafe = join(unsafeParent, "home");
    mkdirSync(unsafe, { mode: 0o700 });
    chmodSync(unsafe, 0o775);
    expect(() => withBackendPublicationConsumerLock(unsafe, () => undefined)).toThrow();

    const missingParent = mkdtempSync(join(tmpdir(), "lcm-consumer-missing-parent-"));
    roots.push(missingParent);
    expect(() => withBackendPublicationConsumerLock(join(missingParent, "missing"), () => undefined)).toThrow();

    const actual = mkdtempSync(join(tmpdir(), "lcm-consumer-canonical-home-"));
    const linkParent = mkdtempSync(join(tmpdir(), "lcm-consumer-canonical-parent-"));
    const canonicalParent = mkdtempSync(join(tmpdir(), "lcm-consumer-canonical-target-"));
    roots.push(actual, linkParent, canonicalParent);
    const linked = join(linkParent, "home");
    symlinkSync(actual, linked, "dir");
    expect(() => withBackendPublicationConsumerLock(linked, () => undefined)).toThrow();
    const parentLink = join(linkParent, "parent");
    symlinkSync(canonicalParent, parentLink, "dir");
    const canonicalSub = join(canonicalParent, "sub");
    mkdirSync(canonicalSub, { mode: 0o700 });
    const nonCanonicalHome = join(parentLink, "sub", "home");
    mkdirSync(nonCanonicalHome, { mode: 0o700 });
    expect(() => withBackendPublicationConsumerLock(nonCanonicalHome, () => undefined))
      .toThrow("path is not canonical");

    // POSIX-only fixture: this must exercise the real root-owned sticky /tmp parent.
    const stickyParentHome = mkdtempSync("/tmp/lcm-consumer-sticky-parent-");
    roots.push(stickyParentHome);
    withBackendPublicationConsumerLock(stickyParentHome, () => undefined);
  });

  it("fails closed when a retained HOME lock parent changes during validation", async () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-consumer-race-home-"));
    roots.push(home);
    const nodeFs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalStat = nodeFs.statSync as (
      path: string,
      options?: { bigint?: boolean },
    ) => { dev: bigint; ino: bigint; [key: string]: unknown };

    await withPatchedFsAsync("statSync", ((candidate: string, options?: { bigint?: boolean }) => {
      const observed = originalStat(candidate, options);
      if (candidate === home) return { ...observed, dev: observed.dev + 1n };
      return observed;
    }) as never, async () => {
      expect(() => withBackendPublicationConsumerLock(home, () => undefined))
        .toThrow("changed during validation");
    });

    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    try {
      Object.defineProperty(process, "getuid", { value: () => -1, configurable: true });
      expect(() => withBackendPublicationConsumerLock(home, () => undefined))
        .toThrow("lock parent is not trusted");
    } finally {
      if (descriptor === undefined) delete (process as { getuid?: unknown }).getuid;
      else Object.defineProperty(process, "getuid", descriptor);
    }

    const nodeFsForOwner = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const originalFstat = nodeFsForOwner.fstatSync as (
      fd: number,
      options?: { bigint?: boolean },
    ) => { uid: bigint; [key: string]: unknown };
    let fstatCalls = 0;
    await withPatchedFsAsync("fstatSync", ((fd: number, options?: { bigint?: boolean }) => {
      const observed = originalFstat(fd, options);
      fstatCalls += 1;
      if (fstatCalls === 1) Object.defineProperty(observed, "uid", { value: observed.uid + 1n });
      return observed;
    }) as never, async () => {
      expect(() => withBackendPublicationConsumerLock(home, () => undefined))
        .toThrow("lock parent is not trusted");
    });
  });

  it("does not create a local publication root for an absent-root consumer preflight", () => {
    const home = mkdtempSync(join(tmpdir(), "lcm-consumer-absent-root-"));
    roots.push(home);
    let callbackCalled = false;

    withBackendPublicationConsumerLock(home, () => {
      callbackCalled = true;
      expect(existsSync(join(home, ".lcm"))).toBe(false);
    });

    expect(callbackCalled).toBe(true);
    expect(existsSync(join(home, ".lcm"))).toBe(false);
  });

  it("rejects a promise-returning synchronous consumer callback before releasing its token", async () => {
    const home = makeHome();
    let continuation: Promise<void> | undefined;

    expect(() => withBackendPublicationConsumerLock(home, (token) => {
      continuation = Promise.resolve().then(() => {
        assertBackendPublicationConsumerAccess({ homeDir: home, lockToken: token });
      });
      return continuation;
    })).toThrow("synchronous backend publication consumer callback returned a promise");

    await expect(continuation).rejects.toMatchObject({ reason: "permit-mismatch" });
  });

  it("rejects a promise returned through the synchronous config seam and revokes its token", async () => {
    const home = makeHome();
    const configPath = join(home, ".lcm", "config.json");
    let continuation: Promise<void> | undefined;

    expect(() => withBackendPublicationConfigLock(configPath, (token) => {
      continuation = Promise.resolve().then(() => {
        assertBackendPublicationConsumerAccess({ homeDir: home, lockToken: token });
      });
      return continuation;
    })).toThrow("synchronous backend publication consumer callback returned a promise");

    await expect(continuation).rejects.toMatchObject({ reason: "permit-mismatch" });
  });

  it("rejects inherited asynchronous work after the owning callback returns", async () => {
    let retained: { assertActive: () => void } | undefined;
    await withRevocablePrivateMutationPermit("test", (permit) => {
      retained = permit;
      permit.assertActive();
    });
    expect(() => retained?.assertActive()).toThrow(PrivateMutationPermitRevokedError);
  });
});
