import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeRouteStorage,
  createCommitCloseBarrier,
  openExistingProject,
  settleProjectStorageExecutions,
  withProjectStorage,
  stagedPostgreSqlUnavailableResponse,
  storageIdentityRequiredResponse,
  storageRouteFailureResponse,
  storageReadFailureResponse,
} from "../../../src/daemon/routes/storage-lifecycle.js";
import { loadDaemonConfig, type DaemonConfig } from "../../../src/daemon/config.js";
import { MachineIdentityFileError } from "../../../src/machine-identity.js";
import { StorageIdentityConfigurationError } from "../../../src/storage/identity-context.js";
import { StorageOperationError } from "../../../src/storage/errors.js";
import { publicationWitnessContentionError } from "../../../src/storage/postgresql/factory.js";
import type { ProjectStorage, StorageBackendFactory } from "../../../src/storage/index.js";
import {
  BackendPublicationJournalError,
  withBackendPublicationConsumerLockAsync,
  type BackendPublicationLockToken,
} from "../../../src/storage/backend-publication.js";
import { clearProjectMapCache } from "../../../src/project-map.js";
import { makeStagedPostgreSqlStorageFactory } from "./mock-storage-factory.js";
import { isAbortError } from "../../../src/daemon/cancellation.js";
import { createAbortError } from "../../../src/daemon/cancellation.js";
import { PrivateMutationLockContentionError } from "../../../src/private-mutation-lock.js";
import * as projectModule from "../../../src/daemon/project.js";
import { projectIdentity } from "../../../src/daemon/project.js";
import type { RoutePublicationAdmission } from "../../../src/daemon/server.js";
import { closeLcmConnection, getPoolStats } from "../../../src/db/connection.js";
import { SqliteStorageBackendFactory } from "../../../src/storage/sqlite/factory.js";

const storageFactorySeam = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("../../../src/storage/index.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../../src/storage/index.js")>(),
  createStorageBackendFactory: storageFactorySeam.create,
}));

afterEach(() => {
  storageFactorySeam.create.mockReset();
});

type TemporaryProject = {
  home: string;
  cwd: string;
  config: DaemonConfig;
};

async function withTemporaryProject<T>(operation: (project: TemporaryProject) => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const home = mkdtempSync(join(tmpdir(), "lcm-storage-lifecycle-"));
  const cwd = join(home, "project");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  clearProjectMapCache();
  try {
    return await operation({
      home,
      cwd,
      config: loadDaemonConfig(join(home, "missing-config.json"), {
        storage: { backend: "sqlite" },
        daemon: { port: 0, idleTimeoutMs: 0 },
      }),
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    clearProjectMapCache();
  }
}

function fakeProject(close: ProjectStorage["close"]): ProjectStorage {
  return {
    backend: "sqlite",
    projectId: "project-id",
    capabilities: {
      transactions: true,
      lexicalSearch: true,
      regexSearch: true,
      nativeFullTextSearch: "available",
      coordination: "local",
    },
    conversations: {} as ProjectStorage["conversations"],
    summaries: {} as ProjectStorage["summaries"],
    context: {} as ProjectStorage["context"],
    largeFiles: {} as ProjectStorage["largeFiles"],
    promotedMemory: {} as ProjectStorage["promotedMemory"],
    recall: {} as ProjectStorage["recall"],
    redactionAdmin: {} as ProjectStorage["redactionAdmin"],
    lexicalSearch: {} as ProjectStorage["lexicalSearch"],
    coordination: {} as ProjectStorage["coordination"],
    transaction: vi.fn(),
    health: vi.fn(),
    close: vi.fn(close),
  };
}

function fakeFactory(options: {
  openExistingProject?: StorageBackendFactory["openExistingProject"];
  openProject?: StorageBackendFactory["openProject"];
  close?: StorageBackendFactory["close"];
}): StorageBackendFactory {
  return {
    backend: "sqlite",
    capabilities: {
      transactions: true,
      lexicalSearch: true,
      regexSearch: true,
      nativeFullTextSearch: "available",
      coordination: "local",
    },
    projectExists: vi.fn(async () => true),
    openExistingProject: options.openExistingProject ?? (async () => null),
    openProject: options.openProject ?? (async () => { throw new Error("openProject not configured"); }),
    health: vi.fn(async () => ({ status: "healthy", backend: "sqlite" })),
    close: options.close ?? vi.fn(async () => undefined),
  };
}

describe("pre-open source admission", () => {
  it("refuses a mutating project before open under its retained publication token", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      const refusal = new Error("source identity changed");
      const openProject = vi.fn(async () => fakeProject(async () => undefined));
      const beforeOpen = vi.fn((identity: { localProjectId: string }, token?: BackendPublicationLockToken) => {
        expect(identity.localProjectId).toBeTruthy();
        expect(token).toBeDefined();
        throw refusal;
      });
      const context = {
        withPublicationAdmission: <T>(operation: (token: BackendPublicationLockToken) => Promise<T> | T) =>
          withBackendPublicationConsumerLockAsync(home, operation),
      };
      await expect(withProjectStorage({ config, cwd, factory: fakeFactory({ openProject }),
        context, mode: "create", beforeOpen }, async () => undefined)).rejects.toBe(refusal);
      expect(beforeOpen).toHaveBeenCalledOnce();
      expect(openProject).not.toHaveBeenCalled();
    });
  });

  it("runs a read prefix guard before opening an existing project", async () => {
    await withTemporaryProject(async ({ cwd, config }) => {
      const refusal = new Error("source identity changed");
      const openExistingProject = vi.fn(async () => fakeProject(async () => undefined));
      const beforeOpen = vi.fn(() => { throw refusal; });
      const context = {
        withReadAdmission: <T>(operation: (token: BackendPublicationLockToken) => Promise<T> | T) =>
          Promise.resolve(operation({})),
      };
      await expect(withProjectStorage({ config, cwd, factory: fakeFactory({ openExistingProject }),
        context, mode: "existing", beforeOpen }, async () => undefined)).rejects.toBe(refusal);
      expect(beforeOpen).toHaveBeenCalledOnce();
      expect(openExistingProject).not.toHaveBeenCalled();
    });
  });
});

describe("route storage cleanup", () => {
  it("settles commit close barriers across acquisition and release edge cases", async () => {
    const barrier = createCommitCloseBarrier();
    await expect(barrier.waitForZero()).resolves.toBeUndefined();

    const firstRelease = vi.fn();
    const secondRelease = vi.fn();
    const first = barrier.acquire(() => ({ release: firstRelease }));
    const second = barrier.acquire(() => ({ release: secondRelease }));
    let settled = 0;
    const waits = [barrier.waitForZero(), barrier.waitForZero()]
      .map(wait => wait.then(() => { settled += 1; }));

    first.release();
    first.release();
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(settled).toBe(0);
    second.release();
    await Promise.all(waits);
    expect(secondRelease).toHaveBeenCalledOnce();
    expect(settled).toBe(2);

    expect(() => barrier.acquire(() => { throw new Error("acquire failed"); }))
      .toThrow("acquire failed");
    await expect(barrier.waitForZero()).resolves.toBeUndefined();

    const throwing = barrier.acquire(() => ({
      release: () => { throw new Error("release failed"); },
    }));
    expect(() => throwing.release()).toThrow("release failed");
    await expect(barrier.waitForZero()).resolves.toBeUndefined();
  });

  it("ignores absent resources", async () => {
    await expect(closeRouteStorage(undefined, undefined)).resolves.toBeUndefined();
  });

  it("attempts every synchronous or asynchronous close and suppresses failures", async () => {
    const projectClose = vi.fn(async () => { throw new Error("project close failed"); });
    const outboxClose = vi.fn(() => { throw new Error("outbox close failed"); });
    const factoryClose = vi.fn(async () => { throw new Error("factory close failed"); });
    await expect(closeRouteStorage(
      { close: projectClose },
      { close: outboxClose },
      { close: factoryClose },
    )).resolves.toBeUndefined();
    expect(projectClose).toHaveBeenCalledOnce();
    expect(outboxClose).toHaveBeenCalledOnce();
    expect(factoryClose).toHaveBeenCalledOnce();
  });

  it("delegates atomic existing-project opens to the selected backend", async () => {
    const identity = { id: "project", canonical: "/project" } as never;
    const project = { close: vi.fn() } as never;
    const factory = {
      openExistingProject: vi.fn(async () => null as typeof project | null),
    } as never;
    await expect(openExistingProject(factory, identity)).resolves.toBeNull();
    factory.openExistingProject.mockResolvedValueOnce(project);
    await expect(openExistingProject(factory, identity)).resolves.toBe(project);
    expect(factory.openExistingProject).toHaveBeenCalledWith(identity, undefined, undefined);
  });

  it("recognizes only typed failures from the staged PostgreSQL factory", async () => {
    const staged = makeStagedPostgreSqlStorageFactory();
    const identity = { id: "project", canonical: "/project" } as never;
    const stagedError = await staged.openExistingProject(identity)
      .catch((error: unknown) => error);

    expect(stagedPostgreSqlUnavailableResponse(undefined, stagedError, "grep"))
      .toBeNull();
    expect(stagedPostgreSqlUnavailableResponse(staged, new Error("other"), "grep"))
      .toBeNull();
    expect(stagedPostgreSqlUnavailableResponse(staged, stagedError, "grep"))
      .toEqual({
        code: "STORAGE_BACKEND_STAGED",
        error: "grep is unavailable while PostgreSQL storage repositories are staged",
        storageBackend: "postgresql",
      });
    expect(storageRouteFailureResponse("postgresql", stagedError, "grep", staged)).toEqual({
      status: 503,
      body: {
        code: "STORAGE_BACKEND_STAGED",
        error: "grep is unavailable while PostgreSQL storage repositories are staged",
        storageBackend: "postgresql",
      },
    });
    expect(storageRouteFailureResponse("sqlite", stagedError, "grep", staged)).toBeNull();
  });

  it("fails PostgreSQL read routes closed with sanitized 503 bodies", () => {
    const canary = "/private/canary-4242 pid 4242";
    const typed = new StorageOperationError(
      "STORAGE_OPERATION_FAILED", "postgresql", "p", "summaries", "recent",
    );
    const staged = makeStagedPostgreSqlStorageFactory();
    const stagedError = new StorageOperationError(
      "STORAGE_OPERATION_FAILED", "postgresql", undefined, "factory", "grep",
    );
    const contention = new PrivateMutationLockContentionError(
      `lock held at ${canary}`,
      { cause: new Error(canary), contendedLock: { path: canary, owner: { pid: 4242 } } as never },
    );

    // Identity precedence, staged factory, and typed passthrough defer to the base classifier.
    const identity = new StorageIdentityConfigurationError("binding required");
    expect(storageReadFailureResponse("postgresql", identity, "search"))
      .toEqual(storageRouteFailureResponse("postgresql", identity, "search"));
    expect(storageReadFailureResponse("postgresql", identity, "search")?.status).toBe(409);
    expect(storageReadFailureResponse("postgresql", stagedError, "grep", staged))
      .toEqual(storageRouteFailureResponse("postgresql", stagedError, "grep", staged));
    expect(storageReadFailureResponse("postgresql", stagedError, "grep", staged)?.status).toBe(503);
    expect(storageReadFailureResponse("postgresql", typed, "recent"))
      .toEqual({ status: 503, body: typed.toJSON() });

    // Cancellation and SQLite keep the route's existing handling.
    expect(storageReadFailureResponse("postgresql", createAbortError(), "search")).toBeNull();
    expect(storageReadFailureResponse("sqlite", contention, "search")).toBeNull();
    expect(storageReadFailureResponse("sqlite", new Error(canary), "search")).toBeNull();

    // Publication-lock contention is a retryable identity failure without lock details.
    const contended = storageReadFailureResponse("postgresql", contention, "describe");
    expect(contended).toEqual({
      status: 503,
      body: new StorageOperationError(
        "STORAGE_OPERATION_FAILED", "postgresql", undefined, "identity", "describe", { retryable: true },
      ).toJSON(),
    });
    expect(contended?.body.retryable).toBe(true);

    // Any other rejection becomes a non-retryable factory failure.
    for (const failure of [new Error(canary), canary, undefined]) {
      const failed = storageReadFailureResponse("postgresql", failure, "expand");
      expect(failed).toEqual({
        status: 503,
        body: new StorageOperationError(
          "STORAGE_OPERATION_FAILED", "postgresql", undefined, "factory", "expand",
        ).toJSON(),
      });
      expect(failed?.body.retryable).toBe(false);
    }

    for (const response of [contended, storageReadFailureResponse("postgresql", new Error(canary), "expand")]) {
      const serialized = JSON.stringify(response?.body);
      expect(serialized).toContain("postgresql");
      expect(serialized).not.toContain("canary");
      expect(serialized).not.toContain("4242");
      expect(serialized).not.toContain("/private");
    }
  });

  it("recognizes only typed PostgreSQL identity admission failures", () => {
    expect(storageIdentityRequiredResponse(new Error("other"))).toBeNull();
    expect(storageRouteFailureResponse("sqlite", new Error("other"), "store")).toBeNull();
    expect(storageIdentityRequiredResponse(
      new StorageIdentityConfigurationError("binding required"),
    )).toEqual({
      code: "STORAGE_IDENTITY_REQUIRED",
      reason: "unbound-postgresql-project",
      error: "binding required",
      storageBackend: "postgresql",
    });
    expect(storageRouteFailureResponse(
      "postgresql",
      new StorageIdentityConfigurationError("binding required"),
      "store",
    )).toEqual({
      status: 409,
      body: {
        code: "STORAGE_IDENTITY_REQUIRED",
        reason: "unbound-postgresql-project",
        error: "binding required",
        storageBackend: "postgresql",
      },
    });
    expect(storageIdentityRequiredResponse(
      new MachineIdentityFileError("machine missing", "Register it."),
    )).toEqual({
      code: "STORAGE_IDENTITY_REQUIRED",
      reason: "machine-identity-unavailable",
      error: "Machine identity is unavailable. Run `lcm machine show` for recovery guidance.",
      storageBackend: "postgresql",
    });
  });

  it("never exposes machine identity paths with spaces or shell metacharacters", () => {
    const machineIdentityPath = "/home/private user/$secret;$(touch nope)/machine'identity.json";
    const response = storageIdentityRequiredResponse(
      new MachineIdentityFileError(
        "machine.json permissions are too broad; expected mode 0600",
        `Run \`chmod 600 -- '${machineIdentityPath}'\`, then retry.`,
      ),
    );

    expect(response).toEqual({
      code: "STORAGE_IDENTITY_REQUIRED",
      reason: "machine-identity-unavailable",
      error: "Machine identity is unavailable. Run `lcm machine show` for recovery guidance.",
      storageBackend: "postgresql",
    });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain(machineIdentityPath);
    expect(serialized).not.toContain("private user");
    expect(serialized).not.toContain("$secret");
    expect(serialized).not.toContain("touch nope");
  });

  it("opens an existing project with the live admission token and closes it before admission release", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      const events: string[] = [];
      let admissionToken: object | undefined;
      const project = fakeProject(async token => {
        expect(token).toBe(admissionToken);
        events.push("project-close");
      });
      const openExistingProject = vi.fn(async (_identity, token) => {
        expect(token).toBeDefined();
        events.push("open-existing");
        return project;
      });
      const factory = fakeFactory({ openExistingProject });
      const controller = new AbortController();
      const withPublicationAdmission = async <T>(operation: (token: object) => Promise<T>): Promise<T> =>
        withBackendPublicationConsumerLockAsync(home, async token => {
          admissionToken = token;
          events.push("admission-enter");
          const result = await operation(token);
          events.push("admission-release");
          return result;
        });

      await expect(withProjectStorage({
        config,
        cwd,
        factory,
        context: { withPublicationAdmission, signal: controller.signal },
        mode: "existing",
      }, async (storage, signal, currentToken) => {
        expect(storage).toBe(project);
        expect(signal).toBe(controller.signal);
        expect(currentToken).toBe(admissionToken);
        events.push("operation");
        return storage.projectId;
      })).resolves.toBe("project-id");

      expect(events).toEqual([
        "admission-enter",
        "open-existing",
        "operation",
        "project-close",
        "admission-release",
      ]);
      expect(factory.close).not.toHaveBeenCalled();
    });
  });

  it("closes a real canonical shared-factory project with the exact request token", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      mkdirSync(join(home, ".lcm"), { mode: 0o700 });
      execFileSync("git", ["init", "-q", cwd]);
      const factory = new SqliteStorageBackendFactory();
      let admissionToken: object | undefined;
      let closeToken: object | undefined;
      const timeline: string[] = [];
      const openProject = factory.openProject.bind(factory);
      vi.spyOn(factory, "openProject").mockImplementation(async (...args) => {
        const project = await openProject(...args);
        const close = project.close.bind(project);
        vi.spyOn(project, "close").mockImplementation(async token => {
          closeToken = token;
          timeline.push("project-close");
          return close(token);
        });
        return project;
      });
      const startedAt = performance.now();
      try {
        await expect(withProjectStorage({
          config,
          cwd,
          factory,
          mode: "create",
          beforeClose: async () => { timeline.push("before-close"); },
          context: {
            signal: new AbortController().signal,
            withPublicationAdmission: operation => withBackendPublicationConsumerLockAsync(
              home,
              async token => {
                admissionToken = token;
                try {
                  return await operation(token);
                } finally {
                  timeline.push("admission-release");
                }
              },
            ),
          },
        }, async storage => {
          timeline.push("operation");
          await storage.conversations.getOrCreateConversation("route-operation");
          return storage.projectId;
        })).resolves.toBeTypeOf("string");
        expect(performance.now() - startedAt).toBeLessThan(1_000);
        expect(closeToken).toBe(admissionToken);
        expect(timeline).toEqual([
          "operation",
          "before-close",
          "project-close",
          "admission-release",
        ]);
        expect(getPoolStats().connections).toEqual([]);
      } finally {
        await factory.close();
        closeLcmConnection();
      }
    });
  });

  it("shares one token-bearing close across abort and finally", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      mkdirSync(join(home, ".lcm"), { mode: 0o700 });
      let token: BackendPublicationLockToken | undefined;
      const controller = new AbortController();
      let releaseClose!: () => void;
      const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
      const close = vi.fn(async (received?: object) => {
        expect(received).toBe(token);
        await closeGate;
      });
      const project = fakeProject(close);
      const factory = fakeFactory({ openProject: async () => project });
      let operationEntered!: () => void;
      const entered = new Promise<void>(resolve => { operationEntered = resolve; });
      const result = withProjectStorage({
        config,
        cwd,
        factory,
        mode: "create",
        context: {
          signal: controller.signal,
          withPublicationAdmission: operation => withBackendPublicationConsumerLockAsync(
            home,
            liveToken => {
              token = liveToken;
              return operation(liveToken);
            },
          ),
        },
      }, async (_storage, signal) => {
        operationEntered();
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        return "aborted-result";
      });
      await entered;
      controller.abort();
      await Promise.resolve();
      expect(close).toHaveBeenCalledOnce();
      releaseClose();
      await expect(result).resolves.toBe("aborted-result");
      expect(close).toHaveBeenCalledOnce();
    });
  });

  it("keeps a successful route result when token-bearing close rejects", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      mkdirSync(join(home, ".lcm"), { mode: 0o700 });
      let token: BackendPublicationLockToken | undefined;
      const close = vi.fn(async (received?: object) => {
        expect(received).toBe(token);
        throw new Error("close failed");
      });
      const project = fakeProject(close);
      await expect(withProjectStorage({
        config,
        cwd,
        factory: fakeFactory({ openProject: async () => project }),
        mode: "create",
        context: {
          signal: new AbortController().signal,
          withPublicationAdmission: operation => withBackendPublicationConsumerLockAsync(
            home,
            liveToken => {
              token = liveToken;
              return operation(liveToken);
            },
          ),
        },
      }, async () => "route-result")).resolves.toBe("route-result");
      expect(close).toHaveBeenCalledOnce();
    });
  });

  it("opens new projects and returns null only when an existing project is absent", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      const project = fakeProject(async () => undefined);
      const openProject = vi.fn(async () => project);
      const openExistingProject = vi.fn(async () => null);
      const factory = fakeFactory({ openProject, openExistingProject });
      const signal = new AbortController().signal;

      await expect(withProjectStorage({
        config,
        cwd,
        factory,
        context: { signal },
        mode: "create",
      }, async storage => storage.projectId)).resolves.toBe("project-id");
      expect(openProject).toHaveBeenCalledOnce();
      expect(project.close).toHaveBeenCalledOnce();

      await expect(withProjectStorage({
        config,
        cwd,
        factory,
        context: { signal },
        mode: "existing",
      }, async () => "must not run")).resolves.toBeNull();
      expect(openExistingProject).toHaveBeenCalledOnce();
    });
  });

  it.each([
    ["id", "create"],
    ["id", "existing"],
    ["localProjectId", "create"],
    ["localProjectId", "existing"],
    ["canonical", "create"],
    ["canonical", "existing"],
    ["remoteProjectId", "create"],
    ["remoteProjectId", "existing"],
  ] as const)("rejects %s drift before a %s open and preserves cleanup ordering", async (field, mode) => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      const liveIdentity = projectIdentity(cwd, config.storage);
      const expectedIdentity = {
        id: liveIdentity.id,
        localProjectId: liveIdentity.localProjectId,
        canonical: liveIdentity.canonical,
        remoteProjectId: liveIdentity.remoteProjectId,
        [field]: field === "canonical" ? "/different/project" : `${field}-drift`,
      };
      const openProject = vi.fn(async () => fakeProject(async () => undefined));
      const openExistingProject = vi.fn(async () => null);
      const factoryClose = vi.fn(async () => undefined);
      const factory = fakeFactory({ openProject, openExistingProject, close: factoryClose });
      storageFactorySeam.create.mockResolvedValueOnce(factory);
      const beforeClose = vi.fn(async () => undefined);
      const operation = vi.fn(async () => "must not run");
      let admissionReleases = 0;
      const listeners = new Set<EventListenerOrEventListenerObject>();
      const controller = new AbortController();
      const signal = {
        get aborted(): boolean { return controller.signal.aborted; },
        get reason(): unknown { return controller.signal.reason; },
        addEventListener: (
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          options?: AddEventListenerOptions | boolean,
        ): void => {
          if (listener !== null) listeners.add(listener);
          controller.signal.addEventListener(type, listener, options);
        },
        removeEventListener: (
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          options?: EventListenerOptions | boolean,
        ): void => {
          if (listener !== null) listeners.delete(listener);
          controller.signal.removeEventListener(type, listener, options);
        },
        dispatchEvent: controller.signal.dispatchEvent.bind(controller.signal),
      } as unknown as AbortSignal;

      await expect(withProjectStorage({
        config,
        cwd,
        context: {
          signal,
          withPublicationAdmission: operation =>
            withBackendPublicationConsumerLockAsync(home, async token => {
              try {
                return await operation(token);
              } finally {
                admissionReleases += 1;
              }
            }),
        },
        mode,
        expectedIdentity,
        beforeClose,
      }, operation)).rejects.toMatchObject({
        name: "BackendPublicationJournalError",
        reason: "unexpected-state",
        message: "project storage identity changed during publication admission",
      } satisfies Partial<BackendPublicationJournalError>);

      expect(openProject).not.toHaveBeenCalled();
      expect(openExistingProject).not.toHaveBeenCalled();
      expect(operation).not.toHaveBeenCalled();
      expect(beforeClose).toHaveBeenCalledOnce();
      expect(admissionReleases).toBe(1);
      expect(factoryClose).toHaveBeenCalledOnce();
      expect(listeners.size).toBe(0);
    });
  });

  it.each(["create", "existing"] as const)("opens the selected %s backend when every identity field is equal", async mode => {
    await withTemporaryProject(async ({ cwd, config }) => {
      const expectedIdentity = projectIdentity(cwd, config.storage);
      const project = fakeProject(async () => undefined);
      const openProject = vi.fn(async () => project);
      const openExistingProject = vi.fn(async () => project);
      const factory = fakeFactory({ openProject, openExistingProject });

      await expect(withProjectStorage({
        config,
        cwd,
        factory,
        mode,
        expectedIdentity,
      }, async storage => storage.projectId)).resolves.toBe("project-id");

      expect(mode === "create" ? openProject : openExistingProject).toHaveBeenCalledOnce();
      expect(mode === "create" ? openExistingProject : openProject).not.toHaveBeenCalled();
    });
  });

  it("closes an owned factory after admission release and preserves a primary operation failure over cleanup failures", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      const events: string[] = [];
      const project = fakeProject(async () => {
        events.push("project-close");
        throw new Error("cleanup failed");
      });
      const factoryClose = vi.fn(async () => {
        events.push("factory-close");
        throw new Error("factory cleanup failed");
      });
      const factory = fakeFactory({
        openProject: async () => project,
        close: factoryClose,
      });
      const operationError = new Error("primary operation failed");
      storageFactorySeam.create.mockResolvedValueOnce(factory);

      await expect(withProjectStorage({
        config,
        cwd,
        context: {
          withPublicationAdmission: async operation => withBackendPublicationConsumerLockAsync(home, async token => {
            try {
              return await operation(token);
            } finally {
              events.push("admission-release");
            }
          }),
          signal: new AbortController().signal,
        },
        mode: "create",
      }, async () => {
        events.push("operation");
        throw operationError;
      })).rejects.toBe(operationError);

      expect(events).toContain("project-close");
      expect(factoryClose).toHaveBeenCalledOnce();
      expect(events).toEqual(["operation", "project-close", "admission-release", "factory-close"]);
    });
  });

  it("closes opened project storage when the operation signal aborts and detaches the listener after settlement", async () => {
    await withTemporaryProject(async ({ cwd, config }) => {
      const controller = new AbortController();
      const project = fakeProject(async () => undefined);
      const factory = fakeFactory({ openProject: async () => project });
      let operationStartedResolve!: () => void;
      const operationStarted = new Promise<void>(resolve => { operationStartedResolve = resolve; });
      const operation = withProjectStorage({
        config,
        cwd,
        factory,
        context: { signal: controller.signal },
        mode: "create",
      }, async (_storage, signal) => {
        operationStartedResolve();
        await new Promise<void>(settle => signal.addEventListener("abort", () => settle(), { once: true }));
        return "aborted";
      });
      await operationStarted;
      controller.abort();
      await expect(operation).resolves.toBe("aborted");
      expect(project.close).toHaveBeenCalledOnce();
      controller.abort();
      expect(project.close).toHaveBeenCalledOnce();

      const alreadyAborted = new AbortController();
      alreadyAborted.abort();
      const preClosedProject = fakeProject(async () => undefined);
      const preClosedFactory = fakeFactory({ openProject: async () => preClosedProject });
      const preAbortedOperation = vi.fn(async (_storage: ProjectStorage, signal: AbortSignal) => {
        expect(signal.aborted).toBe(true);
        return "already-aborted";
      });
      await expect(withProjectStorage({
        config,
        cwd,
        factory: preClosedFactory,
        context: { signal: alreadyAborted.signal },
        mode: "create",
      }, preAbortedOperation)).rejects.toSatisfy(isAbortError);
      expect(preAbortedOperation).not.toHaveBeenCalled();
      expect(preClosedProject.close).not.toHaveBeenCalled();

      const preExistingProject = fakeProject(async () => undefined);
      const preExistingFactory = fakeFactory({ openExistingProject: async () => preExistingProject });
      const preExistingController = new AbortController();
      preExistingController.abort();
      const preExistingOperation = vi.fn(async () => "must not run");
      await expect(withProjectStorage({
        config,
        cwd,
        factory: preExistingFactory,
        context: { signal: preExistingController.signal },
        mode: "existing",
      }, preExistingOperation)).rejects.toSatisfy(isAbortError);
      expect(preExistingOperation).not.toHaveBeenCalled();
      expect(preExistingProject.close).not.toHaveBeenCalled();
    });
  });

  it("cancels in the post-listener abort window without running the operation or leaking listeners", async () => {
    await withTemporaryProject(async ({ cwd, config }) => {
      const controller = new AbortController();
      let addCalls = 0;
      let activeListeners = 0;
      const signal = {
        get aborted(): boolean { return controller.signal.aborted; },
        get reason(): unknown { return controller.signal.reason; },
        addEventListener: (
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          options?: AddEventListenerOptions | boolean,
        ): void => {
          addCalls += 1;
          activeListeners += 1;
          controller.signal.addEventListener(type, listener, options);
          if (addCalls === 2) controller.abort();
        },
        removeEventListener: (
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          options?: EventListenerOptions | boolean,
        ): void => {
          activeListeners -= 1;
          controller.signal.removeEventListener(type, listener, options);
        },
        dispatchEvent: controller.signal.dispatchEvent.bind(controller.signal),
      } as unknown as AbortSignal;
      const project = fakeProject(async () => undefined);
      const factory = fakeFactory({ openProject: async () => project });
      const operation = vi.fn(async () => "must not run");

      await expect(withProjectStorage({
        config,
        cwd,
        factory,
        context: { signal },
        mode: "create",
      }, operation)).rejects.toSatisfy((error: unknown) =>
        isAbortError(error) && error.message === "request cancelled");

      expect(operation).not.toHaveBeenCalled();
      expect(project.close).toHaveBeenCalledOnce();
      expect(addCalls).toBe(2);
      expect(activeListeners).toBe(0);
    });
  });

  it.each(["create", "existing"] as const)("rejects promptly while an ignored %s open is pending and closes a late facade once", async mode => {
    await withTemporaryProject(async ({ cwd, config }) => {
      let resolveOpen!: (project: ProjectStorage) => void;
      const pendingOpen = new Promise<ProjectStorage>(resolve => { resolveOpen = resolve; });
      const project = fakeProject(vi.fn(async () => undefined));
      const factory = fakeFactory({
        openProject: vi.fn(async () => pendingOpen),
        openExistingProject: vi.fn(async () => pendingOpen),
      });
      const controller = new AbortController();
      const operation = vi.fn(async () => "must not run");
      const result = withProjectStorage({
        config,
        cwd,
        factory,
        context: { signal: controller.signal },
        mode,
      }, operation);
      controller.abort("request disconnected");
      await expect(result).rejects.toSatisfy(isAbortError);
      resolveOpen(project);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(operation).not.toHaveBeenCalled();
      expect(project.close).toHaveBeenCalledOnce();
    });
  });

  it("keeps cancellation cleanup ordered after a prompt public rejection", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      const events: string[] = [];
      let resolveOpen!: (project: ProjectStorage) => void;
      const project = fakeProject(async () => { events.push("project-close"); });
      const factoryClose = vi.fn(async () => { events.push("factory-close"); });
      const factory = fakeFactory({
        openProject: vi.fn(async () => new Promise<ProjectStorage>(resolve => { resolveOpen = resolve; })),
        close: factoryClose,
      });
      storageFactorySeam.create.mockResolvedValueOnce(factory);
      const controller = new AbortController();
      const admission = async <T>(operation: (token: object) => Promise<T>): Promise<T> =>
        withBackendPublicationConsumerLockAsync(home, async token => {
          events.push("admission-enter");
          try { return await operation(token); }
          finally { events.push("admission-release"); }
        });
      const result = withProjectStorage({
        config,
        cwd,
        context: { signal: controller.signal, withPublicationAdmission: admission },
        mode: "create",
      }, async () => "must not run");
      await new Promise<void>(resolve => setImmediate(resolve));
      controller.abort();
      await expect(result).rejects.toSatisfy(isAbortError);
      resolveOpen(project);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(events).toEqual(["admission-enter", "project-close", "admission-release", "factory-close"]);
    });
  });

  it("observes cancellation latched while the public pending-open listener is attached", async () => {
    await withTemporaryProject(async ({ cwd, config }) => {
      const controller = new AbortController();
      let abortOnAdd = true;
      const signal = {
        get aborted(): boolean { return controller.signal.aborted; },
        get reason(): unknown { return controller.signal.reason; },
        addEventListener: (
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          options?: AddEventListenerOptions | boolean,
        ): void => {
          controller.signal.addEventListener(type, listener, options);
          if (abortOnAdd) {
            abortOnAdd = false;
            controller.abort();
          }
        },
        removeEventListener: controller.signal.removeEventListener.bind(controller.signal),
        dispatchEvent: controller.signal.dispatchEvent.bind(controller.signal),
      } as unknown as AbortSignal;
      let resolveOpen!: (project: ProjectStorage) => void;
      const project = fakeProject(async () => undefined);
      const factory = fakeFactory({
        openProject: vi.fn(async () => new Promise<ProjectStorage>(resolve => { resolveOpen = resolve; })),
      });
      const operation = vi.fn(async () => "must not run");

      const result = withProjectStorage({
        config,
        cwd,
        factory,
        context: { signal },
        mode: "create",
      }, operation);

      await expect(result).rejects.toSatisfy(isAbortError);
      resolveOpen(project);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(operation).not.toHaveBeenCalled();
      expect(project.close).toHaveBeenCalledOnce();
    });
  });

  it("does not release a retained publication token before signal-aware open settles", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      let resolveOpen!: (project: ProjectStorage) => void;
      const project = fakeProject(async () => undefined);
      const openExisting = vi.fn(async () => new Promise<ProjectStorage>(resolve => { resolveOpen = resolve; }));
      const factory = fakeFactory({ openExistingProject: openExisting });
      const controller = new AbortController();
      await withBackendPublicationConsumerLockAsync(home, async token => {
        const pending = withProjectStorage({
          config,
          cwd,
          factory,
          context: { signal: controller.signal, publicationLockToken: token },
          mode: "existing",
        }, async () => "must not run");
        await vi.waitFor(() => expect(openExisting).toHaveBeenCalledOnce());
        controller.abort();
        let settled = false;
        void pending.then(() => { settled = true; }, () => { settled = true; });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(settled).toBe(false);
        resolveOpen(project);
        await expect(pending).rejects.toSatisfy(isAbortError);
        expect(project.close).toHaveBeenCalledOnce();
      });
    });
  });

  it("consumes a late open rejection without an unhandled rejection", async () => {
    await withTemporaryProject(async ({ cwd, config }) => {
      let rejectOpen!: (error: unknown) => void;
      const pendingOpen = new Promise<ProjectStorage>((_resolve, reject) => { rejectOpen = reject; });
      const factory = fakeFactory({ openProject: vi.fn(async () => pendingOpen) });
      const controller = new AbortController();
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        const result = withProjectStorage({
          config,
          cwd,
          factory,
          context: { signal: controller.signal },
          mode: "create",
        }, async () => "must not run");
        controller.abort();
        await expect(result).rejects.toSatisfy(isAbortError);
        rejectOpen(new Error("late open failed"));
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.removeListener("unhandledRejection", unhandled);
      }
    });
  });

  it("maps only selected PostgreSQL StorageOperationError failures to a cause-free 503 body", () => {
    const error = new StorageOperationError(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      "project-id",
      "conversations",
      "store",
      { retryable: true },
    );
    expect(storageRouteFailureResponse("postgresql", error, "store")).toEqual({
      status: 503,
      body: error.toJSON(),
    });
    expect(storageRouteFailureResponse("sqlite", error, "store")).toBeNull();
    expect(storageRouteFailureResponse(
      "postgresql",
      new StorageIdentityConfigurationError("binding required"),
      "store",
    )).toEqual({
      status: 409,
      body: {
        code: "STORAGE_IDENTITY_REQUIRED",
        reason: "unbound-postgresql-project",
        error: "binding required",
        storageBackend: "postgresql",
      },
    });
  });

  it("does not close a factory when PostgreSQL factory construction fails before an active factory exists", async () => {
    const error = new StorageOperationError(
      "STORAGE_INITIALIZATION_FAILED",
      "postgresql",
      undefined,
      "factory",
      "createFactory",
    );
    storageFactorySeam.create.mockRejectedValueOnce(error);
    await expect(withProjectStorage({
      config: { storage: { backend: "postgresql" } } as DaemonConfig,
      cwd: "/project",
      mode: "create",
    }, async () => "must not run")).rejects.toBe(error);
    expect(storageFactorySeam.create).toHaveBeenCalledOnce();
    expect(storageRouteFailureResponse("postgresql", error, "createFactory")).toEqual({
      status: 503,
      body: error.toJSON(),
    });
    expect(storageRouteFailureResponse("sqlite", error, "createFactory")).toBeNull();
  });
});

describe("PostgreSQL read prefix retry under bounded admission", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  type Events = string[];

  /** Bounded read admission stand-in: a real consumer lock around the prefix. */
  function readAdmission(home: string, events: Events) {
    const tokens: unknown[] = [];
    const admit = vi.fn(async <T>(
      operation: (token: BackendPublicationLockToken) => Promise<T> | T,
      _signal?: AbortSignal,
    ): Promise<T> => withBackendPublicationConsumerLockAsync(home, async token => {
      tokens.push(token);
      events.push("admission-enter");
      try {
        return await operation(token);
      } finally {
        events.push("admission-release");
      }
    }));
    return { admit, tokens, context: (signal: AbortSignal) => ({ signal, withReadAdmission: admit as RoutePublicationAdmission }) };
  }

  function contendIdentity(times: number) {
    const original = projectModule.projectIdentity;
    const identityTokens: unknown[] = [];
    let remaining = times;
    vi.spyOn(projectModule, "projectIdentity").mockImplementation(((...args: Parameters<typeof original>) => {
      identityTokens.push(args[2]);
      if (args[2] === undefined && remaining > 0) {
        remaining -= 1;
        throw new PrivateMutationLockContentionError("worktree reconciliation is busy");
      }
      return original(...args);
    }) as typeof original);
    return identityTokens;
  }

  it("keeps an uncontended read on the unadmitted path without a token", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      const events: Events = [];
      const admission = readAdmission(home, events);
      const project = fakeProject(async () => undefined);
      const openExisting = vi.fn(async (_identity: unknown, token?: unknown) => {
        expect(token).toBeUndefined();
        return project;
      });
      const factory = fakeFactory({ openExistingProject: openExisting as StorageBackendFactory["openExistingProject"] });
      const controller = new AbortController();
      await expect(withProjectStorage({
        config, cwd, factory, context: admission.context(controller.signal), mode: "existing",
      }, async (storage, signal, token) => {
        expect(signal).toBe(controller.signal);
        expect(token).toBeUndefined();
        return storage.projectId;
      })).resolves.toBe("project-id");
      expect(admission.admit).not.toHaveBeenCalled();
      expect(project.close).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(factory.close).not.toHaveBeenCalled();

      openExisting.mockResolvedValueOnce(null as never);
      await expect(withProjectStorage({
        config, cwd, factory, context: admission.context(controller.signal), mode: "existing",
      }, async () => "must not run")).resolves.toBeNull();
      expect(admission.admit).not.toHaveBeenCalled();
    });
  });

  it("retries identity contention once inside admission and runs the operation and close outside it", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      const events: Events = [];
      const admission = readAdmission(home, events);
      const identityTokens = contendIdentity(1);
      const project = fakeProject(async () => { events.push("project-close"); });
      const openExisting = vi.fn(async (_identity: unknown, token?: unknown) => {
        events.push("open");
        expect(token).toBe(admission.tokens[0]);
        return project;
      });
      const factory = fakeFactory({ openExistingProject: openExisting as StorageBackendFactory["openExistingProject"] });
      const controller = new AbortController();
      await expect(withProjectStorage({
        config, cwd, factory, context: admission.context(controller.signal), mode: "existing",
      }, async (_storage, _signal, token) => {
        events.push("operation");
        expect(token).toBeUndefined();
        return "done";
      })).resolves.toBe("done");
      expect(admission.admit).toHaveBeenCalledExactlyOnceWith(expect.any(Function), controller.signal);
      expect(identityTokens).toEqual([undefined, admission.tokens[0]]);
      expect(events).toEqual(["admission-enter", "open", "admission-release", "operation", "project-close"]);
      expect(project.close).toHaveBeenCalledExactlyOnceWith(undefined);
    });
  });

  it("retries contention from owned-factory creation, reusing the factory and closing it once after release", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      const events: Events = [];
      const admission = readAdmission(home, events);
      const project = fakeProject(async () => { events.push("project-close"); });
      const factory = fakeFactory({
        openExistingProject: async () => project,
        close: vi.fn(async () => { events.push("factory-close"); }),
      });
      storageFactorySeam.create
        .mockRejectedValueOnce(new PrivateMutationLockContentionError("busy"))
        .mockResolvedValueOnce(factory);
      await expect(withProjectStorage({
        config, cwd, context: admission.context(new AbortController().signal), mode: "existing",
      }, async () => { events.push("operation"); return "done"; })).resolves.toBe("done");
      expect(storageFactorySeam.create).toHaveBeenCalledTimes(2);
      expect(storageFactorySeam.create.mock.calls[0]?.[3]).toBeUndefined();
      expect(storageFactorySeam.create.mock.calls[1]?.[3]).toBe(admission.tokens[0]);
      expect(events).toEqual([
        "admission-enter", "admission-release", "operation", "project-close", "factory-close",
      ]);
      expect(factory.close).toHaveBeenCalledOnce();
    });
  });

  it("reuses a factory created by the unadmitted attempt when identity contends", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      const events: Events = [];
      const admission = readAdmission(home, events);
      contendIdentity(1);
      const project = fakeProject(async () => undefined);
      const factory = fakeFactory({
        openExistingProject: async () => project,
        close: vi.fn(async () => { events.push("factory-close"); }),
      });
      storageFactorySeam.create.mockResolvedValueOnce(factory);
      await expect(withProjectStorage({
        config, cwd, context: admission.context(new AbortController().signal), mode: "existing",
      }, async () => "done")).resolves.toBe("done");
      expect(storageFactorySeam.create).toHaveBeenCalledOnce();
      expect(factory.close).toHaveBeenCalledOnce();
      expect(events).toEqual(["admission-enter", "admission-release", "factory-close"]);
    });
  });

  it.each([
    ["the open's publication-witness contention", () => publicationWitnessContentionError(
      undefined, "openExistingProject")],
    ["typed contention from the open", () => new PrivateMutationLockContentionError("busy")],
  ] as const)("retries %s once inside admission", async (_label, makeError) => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      const events: Events = [];
      const admission = readAdmission(home, events);
      const project = fakeProject(async () => undefined);
      const openExisting = vi.fn<StorageBackendFactory["openExistingProject"]>()
        .mockRejectedValueOnce(makeError())
        .mockImplementationOnce(async (_identity, token) => {
          expect(token).toBe(admission.tokens[0]);
          return project;
        });
      const factory = fakeFactory({ openExistingProject: openExisting });
      await expect(withProjectStorage({
        config, cwd, factory, context: admission.context(new AbortController().signal), mode: "existing",
      }, async () => "done")).resolves.toBe("done");
      expect(openExisting).toHaveBeenCalledTimes(2);
      expect(openExisting.mock.calls[0]?.[1]).toBeUndefined();
      expect(admission.admit).toHaveBeenCalledOnce();
      expect(project.close).toHaveBeenCalledOnce();
    });
  });

  it("retries a contended create-mode open inside admission", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      const admission = readAdmission(home, []);
      const project = fakeProject(async () => undefined);
      const openProject = vi.fn<StorageBackendFactory["openProject"]>()
        .mockRejectedValueOnce(new PrivateMutationLockContentionError("busy"))
        .mockResolvedValueOnce(project);
      await expect(withProjectStorage({
        config, cwd, factory: fakeFactory({ openProject }),
        context: admission.context(new AbortController().signal), mode: "create",
      }, async storage => storage.projectId)).resolves.toBe("project-id");
      expect(openProject).toHaveBeenCalledTimes(2);
      expect(openProject.mock.calls[1]?.[1]).toBe(admission.tokens[0]);
    });
  });

  it("does not retry a factory construction failure, even with the initialization code", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      const admission = readAdmission(home, []);
      const error = new StorageOperationError(
        "STORAGE_INITIALIZATION_FAILED", "postgresql", undefined, "factory", "createFactory");
      storageFactorySeam.create.mockRejectedValueOnce(error);
      await expect(withProjectStorage({
        config, cwd, context: admission.context(new AbortController().signal), mode: "existing",
      }, async () => "must not run")).rejects.toBe(error);
      expect(storageFactorySeam.create).toHaveBeenCalledOnce();
      expect(admission.admit).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["an abort", () => createAbortError(new Error("gone"))],
    ["a journal error", () => new BackendPublicationJournalError("unexpected-state", "journal moved")],
    ["a generic error", () => new Error("boom")],
    ["a non-initialization storage error", () => new StorageOperationError(
      "STORAGE_OPERATION_FAILED", "postgresql", undefined, "factory", "openExistingProject")],
    ["an unmarked initialization failure such as a database outage", () => new StorageOperationError(
      "STORAGE_INITIALIZATION_FAILED", "postgresql", undefined, "factory", "openExistingProject")],
  ] as const)("does not retry %s from the open", async (_label, makeError) => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      const admission = readAdmission(home, []);
      const error = makeError();
      const openExisting = vi.fn<StorageBackendFactory["openExistingProject"]>().mockRejectedValue(error);
      const beforeClose = vi.fn(async () => undefined);
      await expect(withProjectStorage({
        config, cwd, factory: fakeFactory({ openExistingProject: openExisting }),
        context: admission.context(new AbortController().signal), mode: "existing", beforeClose,
      }, async () => "must not run")).rejects.toBe(error);
      expect(openExisting).toHaveBeenCalledOnce();
      expect(admission.admit).not.toHaveBeenCalled();
      expect(beforeClose).toHaveBeenCalledOnce();
    });
  });

  it("does not retry an expected-identity mismatch", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      const admission = readAdmission(home, []);
      const live = projectIdentity(cwd, config.storage);
      const openExisting = vi.fn<StorageBackendFactory["openExistingProject"]>();
      await expect(withProjectStorage({
        config, cwd, factory: fakeFactory({ openExistingProject: openExisting }),
        context: admission.context(new AbortController().signal), mode: "existing",
        expectedIdentity: { ...live, localProjectId: "other", id: "other" },
      }, async () => "must not run")).rejects.toBeInstanceOf(BackendPublicationJournalError);
      expect(openExisting).not.toHaveBeenCalled();
      expect(admission.admit).not.toHaveBeenCalled();
    });
  });

  it("makes exactly one admitted retry and returns its failure unchanged", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      const admission = readAdmission(home, []);
      const second = new StorageOperationError(
        "STORAGE_INITIALIZATION_FAILED", "postgresql", undefined, "factory", "openExistingProject");
      const openExisting = vi.fn<StorageBackendFactory["openExistingProject"]>()
        .mockRejectedValueOnce(publicationWitnessContentionError(undefined, "openExistingProject"))
        .mockRejectedValueOnce(second);
      await expect(withProjectStorage({
        config, cwd, factory: fakeFactory({ openExistingProject: openExisting }),
        context: admission.context(new AbortController().signal), mode: "existing",
      }, async () => "must not run")).rejects.toBe(second);
      expect(openExisting).toHaveBeenCalledTimes(2);
      expect(admission.admit).toHaveBeenCalledOnce();
      expect(storageReadFailureResponse("postgresql", second, "search")).toEqual({
        status: 503,
        body: second.toJSON(),
      });
      expect(second.toJSON().retryable).toBeFalsy();
    });
  });

  it("propagates an admission that expires before the retry runs, without a project to close", async () => {
    await withTemporaryProject(async ({ cwd, config }) => {
      const expiry = new PrivateMutationLockContentionError("daemon publication work is in progress; retry the read");
      const openExisting = vi.fn<StorageBackendFactory["openExistingProject"]>()
        .mockRejectedValueOnce(new PrivateMutationLockContentionError("busy"));
      const beforeClose = vi.fn(async () => undefined);
      const withReadAdmission = vi.fn(async () => { throw expiry; });
      await expect(withProjectStorage({
        config, cwd, factory: fakeFactory({ openExistingProject: openExisting }),
        context: { signal: new AbortController().signal, withReadAdmission: withReadAdmission as never },
        mode: "existing", beforeClose,
      }, async () => "must not run")).rejects.toBe(expiry);
      expect(withReadAdmission).toHaveBeenCalledOnce();
      expect(openExisting).toHaveBeenCalledOnce();
      expect(beforeClose).toHaveBeenCalledOnce();
      expect(storageReadFailureResponse("postgresql", expiry, "search")).toMatchObject({
        status: 503,
        body: { retryable: true },
      });
    });
  });

  it("closes the opened project once without the operation or beforeClose when admission rejects after the prefix", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      const events: Events = [];
      const rejection = new Error("post-callback admission check failed");
      const project = fakeProject(async () => { events.push("project-close"); throw new Error("close failed"); });
      const beforeClose = vi.fn(async () => { events.push("before-close"); });
      const operation = vi.fn(async () => "must not run");
      const factory = fakeFactory({
        openExistingProject: vi.fn<StorageBackendFactory["openExistingProject"]>()
          .mockRejectedValueOnce(new PrivateMutationLockContentionError("busy"))
          .mockResolvedValueOnce(project),
      });
      const withReadAdmission = vi.fn(async (callback: (token: BackendPublicationLockToken) => Promise<unknown>) =>
        withBackendPublicationConsumerLockAsync(home, async token => {
          await callback(token);
          events.push("admission-callback-returned");
          throw rejection;
        }));
      await expect(withProjectStorage({
        config, cwd, factory, context: { signal: new AbortController().signal, withReadAdmission: withReadAdmission as never },
        mode: "existing", beforeClose,
      }, operation)).rejects.toBe(rejection);
      expect(events).toEqual(["admission-callback-returned", "project-close"]);
      expect(project.close).toHaveBeenCalledOnce();
      expect(beforeClose).not.toHaveBeenCalled();
      expect(operation).not.toHaveBeenCalled();
    });
  });

  it("rejects with an abort while the retry is queued and never opens or runs anything", async () => {
    await withTemporaryProject(async ({ cwd, config }) => {
      const controller = new AbortController();
      const project = fakeProject(async () => undefined);
      const openExisting = vi.fn<StorageBackendFactory["openExistingProject"]>()
        .mockRejectedValueOnce(new PrivateMutationLockContentionError("busy"))
        .mockResolvedValue(project);
      let queuedResolve!: () => void;
      const queued = new Promise<void>(resolve => { queuedResolve = resolve; });
      const withReadAdmission = vi.fn((_callback: unknown, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          queuedResolve();
          signal.addEventListener("abort", () => reject(createAbortError(signal.reason)), { once: true });
        }));
      const operation = vi.fn(async () => "must not run");
      const result = withProjectStorage({
        config, cwd, factory: fakeFactory({ openExistingProject: openExisting }),
        context: { signal: controller.signal, withReadAdmission: withReadAdmission as never }, mode: "existing",
      }, operation);
      await queued;
      controller.abort();
      await expect(result).rejects.toSatisfy(isAbortError);
      expect(openExisting).toHaveBeenCalledOnce();
      expect(operation).not.toHaveBeenCalled();
      expect(project.close).not.toHaveBeenCalled();
    });
  });

  it("stops at the admitted prefix when the request is aborted as the turn is granted", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      const controller = new AbortController();
      const events: Events = [];
      const admission = readAdmission(home, events);
      const openExisting = vi.fn<StorageBackendFactory["openExistingProject"]>()
        .mockRejectedValueOnce(new PrivateMutationLockContentionError("busy"));
      const withReadAdmission = vi.fn(async (callback: (token: BackendPublicationLockToken) => Promise<unknown>, signal: AbortSignal) => {
        controller.abort();
        return admission.admit(callback, signal);
      });
      await expect(withProjectStorage({
        config, cwd, factory: fakeFactory({ openExistingProject: openExisting }),
        context: { signal: controller.signal, withReadAdmission: withReadAdmission as never }, mode: "existing",
      }, async () => "must not run")).rejects.toSatisfy(isAbortError);
      expect(openExisting).toHaveBeenCalledOnce();
    });
  });

  it("closes a project opened by the retry when the request aborts during the operation", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      const controller = new AbortController();
      const admission = readAdmission(home, []);
      const project = fakeProject(async () => undefined);
      const factory = fakeFactory({
        openExistingProject: vi.fn<StorageBackendFactory["openExistingProject"]>()
          .mockRejectedValueOnce(new PrivateMutationLockContentionError("busy"))
          .mockResolvedValueOnce(project),
      });
      let started!: () => void;
      const operationStarted = new Promise<void>(resolve => { started = resolve; });
      const result = withProjectStorage({
        config, cwd, factory, context: admission.context(controller.signal), mode: "existing",
      }, async (_storage, signal) => {
        started();
        await new Promise<void>(settle => signal.addEventListener("abort", () => settle(), { once: true }));
        return "aborted";
      });
      await operationStarted;
      controller.abort();
      await expect(result).resolves.toBe("aborted");
      expect(project.close).toHaveBeenCalledOnce();
    });
  });

  it("closes a project whose open finished after the request aborted", async () => {
    await withTemporaryProject(async ({ cwd, config }) => {
      const controller = new AbortController();
      const project = fakeProject(async () => undefined);
      const operation = vi.fn(async () => "must not run");
      const factory = fakeFactory({
        openExistingProject: async () => {
          controller.abort();
          return project;
        },
      });
      await expect(withProjectStorage({
        config, cwd, factory,
        context: { signal: controller.signal, withReadAdmission: vi.fn() as never }, mode: "existing",
      }, operation)).rejects.toSatisfy(isAbortError);
      await vi.waitFor(() => expect(project.close).toHaveBeenCalledOnce());
      expect(operation).not.toHaveBeenCalled();
    });
  });

  it("cancels in the post-listener abort window of the read path", async () => {
    await withTemporaryProject(async ({ cwd, config }) => {
      const controller = new AbortController();
      let addCalls = 0;
      let activeListeners = 0;
      const signal = {
        get aborted(): boolean { return controller.signal.aborted; },
        get reason(): unknown { return controller.signal.reason; },
        addEventListener: (
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          options?: AddEventListenerOptions | boolean,
        ): void => {
          addCalls += 1;
          activeListeners += 1;
          controller.signal.addEventListener(type, listener, options);
          if (addCalls === 2) controller.abort();
        },
        removeEventListener: (
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          options?: EventListenerOptions | boolean,
        ): void => {
          activeListeners -= 1;
          controller.signal.removeEventListener(type, listener, options);
        },
        dispatchEvent: controller.signal.dispatchEvent.bind(controller.signal),
      } as unknown as AbortSignal;
      const project = fakeProject(async () => undefined);
      const operation = vi.fn(async () => "must not run");
      await expect(withProjectStorage({
        config, cwd, factory: fakeFactory({ openExistingProject: async () => project }),
        context: { signal, withReadAdmission: vi.fn() as never }, mode: "existing",
      }, operation)).rejects.toSatisfy((error: unknown) =>
        isAbortError(error) && error.message === "request cancelled");
      expect(operation).not.toHaveBeenCalled();
      expect(project.close).toHaveBeenCalledOnce();
      expect(addCalls).toBe(2);
      expect(activeListeners).toBe(0);
    });
  });

  it("runs beforeClose before the close on the normal read path but not when setup never completed", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      const events: Events = [];
      const admission = readAdmission(home, events);
      const project = fakeProject(async () => { events.push("project-close"); });
      const factory = fakeFactory({ openExistingProject: async () => project });
      await expect(withProjectStorage({
        config, cwd, factory, context: admission.context(new AbortController().signal), mode: "existing",
        beforeClose: async () => { events.push("before-close"); },
      }, async () => "done")).resolves.toBe("done");
      expect(events).toEqual(["before-close", "project-close"]);

      // Identity contends on both attempts: setup never completes, so (as for a
      // mutator whose identity throws) there is nothing to close and no beforeClose.
      const beforeClose = vi.fn(async () => undefined);
      const stillBusy = new PrivateMutationLockContentionError("worktree busy");
      vi.spyOn(projectModule, "projectIdentity").mockImplementation((() => {
        throw stillBusy;
      }) as typeof projectModule.projectIdentity);
      await expect(withProjectStorage({
        config, cwd, factory, context: admission.context(new AbortController().signal),
        mode: "existing", beforeClose,
      }, async () => "must not run")).rejects.toBe(stillBusy);
      expect(admission.admit).toHaveBeenCalledOnce();
      expect(beforeClose).not.toHaveBeenCalled();
    });
  });

  it("ignores the read admission for mutators and retained-token routes", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      const events: Events = [];
      const admission = readAdmission(home, events);
      const project = fakeProject(async () => undefined);
      const factory = fakeFactory({ openExistingProject: async () => project });
      const mutatorBeforeClose = vi.fn(async () => undefined);
      await expect(withProjectStorage({
        config, cwd, factory, mode: "existing", beforeClose: mutatorBeforeClose,
        context: {
          signal: new AbortController().signal,
          withReadAdmission: admission.admit as RoutePublicationAdmission,
          withPublicationAdmission: async operation =>
            withBackendPublicationConsumerLockAsync(home, token => operation(token)),
        },
      }, async (_storage, _signal, token) => token !== undefined)).resolves.toBe(true);
      expect(admission.admit).not.toHaveBeenCalled();
      expect(mutatorBeforeClose).toHaveBeenCalledOnce();

      await withBackendPublicationConsumerLockAsync(home, async retained => {
        await expect(withProjectStorage({
          config, cwd, factory, mode: "existing",
          context: {
            signal: new AbortController().signal,
            publicationLockToken: retained,
            withReadAdmission: admission.admit as RoutePublicationAdmission,
          },
        }, async (_storage, _signal, token) => token === retained)).resolves.toBe(true);
      });
      expect(admission.admit).not.toHaveBeenCalled();
    });
  });

  it("awaits beforeClose for a mutator-admitted run that opens nothing", async () => {
    await withTemporaryProject(async ({ home, cwd, config }) => {
      const beforeClose = vi.fn(async () => undefined);
      await expect(withProjectStorage({
        config, cwd, factory: fakeFactory({ openExistingProject: async () => null }), mode: "existing", beforeClose,
        context: {
          signal: new AbortController().signal,
          withPublicationAdmission: async operation =>
            withBackendPublicationConsumerLockAsync(home, token => operation(token)),
        },
      }, async () => "must not run")).resolves.toBeNull();
      expect(beforeClose).toHaveBeenCalledOnce();
    });
  });
});

describe("settleProjectStorageExecutions", () => {
  type Deferred = { promise: Promise<void>; release: () => void };
  const deferred = (): Deferred => {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
  };
  const flush = async (): Promise<void> => {
    for (let turn = 0; turn < 10; turn += 1) await new Promise<void>(resolve => setImmediate(resolve));
  };
  /** A shared factory whose project open resolves only when released. */
  function gatedFactory(events: string[], gate: Deferred, entered: Deferred = deferred()): StorageBackendFactory {
    return fakeFactory({
      openProject: async () => {
        events.push("open:start");
        entered.release();
        await gate.promise;
        events.push("open:end");
        return fakeProject(async () => { events.push("project.close"); });
      },
    });
  }

  it("resolves immediately when nothing ran on the factory", async () => {
    const factory = fakeFactory({});
    await expect(settleProjectStorageExecutions(factory)).resolves.toBeUndefined();
    await withTemporaryProject(async ({ cwd, config }) => {
      await withProjectStorage({
        config, cwd, factory: fakeFactory({ openProject: async () => fakeProject(async () => undefined) }),
        mode: "create",
      }, async () => "done");
    });
    await expect(settleProjectStorageExecutions(factory)).resolves.toBeUndefined();
  });

  it("waits for the private open and close of an aborted route whose public promise already rejected", async () => {
    await withTemporaryProject(async ({ cwd, config }) => {
      const events: string[] = [];
      const gate = deferred();
      const entered = deferred();
      const factory = gatedFactory(events, gate, entered);
      const controller = new AbortController();
      const operation = vi.fn(async () => "must not run");
      const result = withProjectStorage({
        config, cwd, factory, mode: "create", context: { signal: controller.signal },
      }, operation);
      await entered.promise;
      controller.abort();
      await expect(result).rejects.toSatisfy(isAbortError);

      let settled = false;
      const settling = settleProjectStorageExecutions(factory).then(() => { settled = true; });
      await flush();
      expect(settled).toBe(false);
      expect(events).toEqual(["open:start"]);

      gate.release();
      await settling;
      expect(events).toEqual(["open:start", "open:end", "project.close"]);
      expect(operation).not.toHaveBeenCalled();
    });
  });

  it("also waits for an execution that starts while it is waiting", async () => {
    await withTemporaryProject(async ({ cwd, config }) => {
      const events: string[] = [];
      const first = deferred();
      const second = deferred();
      const firstEntered = deferred();
      const secondEntered = deferred();
      const gates = [first, second];
      const entered = [firstEntered, secondEntered];
      let opened = 0;
      const factory = fakeFactory({
        openProject: async () => {
          const index = opened;
          opened += 1;
          entered[index]!.release();
          await gates[index]!.promise;
          events.push(`open:${index}`);
          return fakeProject(async () => { events.push(`close:${index}`); });
        },
      });
      const run = () => withProjectStorage({ config, cwd, factory, mode: "create" }, async () => undefined);
      const firstRun = run();
      await firstEntered.promise;

      let settled = false;
      const settling = settleProjectStorageExecutions(factory).then(() => { settled = true; });
      const secondRun = run();
      await secondEntered.promise;

      first.release();
      await firstRun;
      await flush();
      expect(settled).toBe(false);

      second.release();
      await settling;
      await secondRun;
      expect(events).toEqual(["open:0", "close:0", "open:1", "close:1"]);
    });
  });

  it("never rejects when the private execution fails", async () => {
    await withTemporaryProject(async ({ cwd, config }) => {
      const gate = deferred();
      const entered = deferred();
      const factory = fakeFactory({
        openProject: async () => {
          entered.release();
          await gate.promise;
          throw new Error("open failed");
        },
      });
      const result = withProjectStorage({ config, cwd, factory, mode: "create" }, async () => undefined);
      const rejected = expect(result).rejects.toThrow("open failed");
      await entered.promise;
      const settling = settleProjectStorageExecutions(factory);
      gate.release();
      await rejected;
      await expect(settling).resolves.toBeUndefined();
    });
  });

  it("does not track executions that own their factory", async () => {
    await withTemporaryProject(async ({ cwd, config }) => {
      const events: string[] = [];
      const gate = deferred();
      const entered = deferred();
      const owned = gatedFactory(events, gate, entered);
      storageFactorySeam.create.mockResolvedValueOnce(owned);
      const controller = new AbortController();
      const result = withProjectStorage({
        config, cwd, mode: "create", context: { signal: controller.signal },
      }, async () => undefined);
      await entered.promise;
      controller.abort();
      await expect(result).rejects.toSatisfy(isAbortError);

      await expect(settleProjectStorageExecutions(owned)).resolves.toBeUndefined();
      expect(events).toEqual(["open:start"]);
      gate.release();
      await vi.waitFor(() => expect(owned.close).toHaveBeenCalledOnce());
      expect(events).toEqual(["open:start", "open:end", "project.close"]);
    });
  });
});
