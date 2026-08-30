import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeRouteStorage,
  createCommitCloseBarrier,
  openExistingProject,
  withProjectStorage,
  stagedPostgreSqlUnavailableResponse,
  storageIdentityRequiredResponse,
  storageRouteFailureResponse,
} from "../../../src/daemon/routes/storage-lifecycle.js";
import { loadDaemonConfig, type DaemonConfig } from "../../../src/daemon/config.js";
import { MachineIdentityFileError } from "../../../src/machine-identity.js";
import { StorageIdentityConfigurationError } from "../../../src/storage/identity-context.js";
import { StorageOperationError } from "../../../src/storage/errors.js";
import type { ProjectStorage, StorageBackendFactory } from "../../../src/storage/index.js";
import { withBackendPublicationConsumerLockAsync } from "../../../src/storage/backend-publication.js";
import { clearProjectMapCache } from "../../../src/project-map.js";
import { makeStagedPostgreSqlStorageFactory } from "./mock-storage-factory.js";
import { isAbortError } from "../../../src/daemon/cancellation.js";

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

function fakeProject(close: () => Promise<void>): ProjectStorage {
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

  it("recognizes only typed PostgreSQL identity admission failures", () => {
    expect(storageIdentityRequiredResponse(new Error("other"))).toBeNull();
    expect(storageRouteFailureResponse("sqlite", new Error("other"), "store")).toBeNull();
    expect(storageIdentityRequiredResponse(
      new StorageIdentityConfigurationError("binding required"),
    )).toEqual({
      code: "STORAGE_IDENTITY_REQUIRED",
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
        error: "binding required",
        storageBackend: "postgresql",
      },
    });
    expect(storageIdentityRequiredResponse(
      new MachineIdentityFileError("machine missing", "Register it."),
    )).toEqual({
      code: "STORAGE_IDENTITY_REQUIRED",
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
      const project = fakeProject(async () => { events.push("project-close"); });
      const openExistingProject = vi.fn(async (_identity, token) => {
        expect(token).toBeDefined();
        events.push("open-existing");
        return project;
      });
      const factory = fakeFactory({ openExistingProject });
      const controller = new AbortController();
      const withPublicationAdmission = async <T>(operation: (token: object) => Promise<T>): Promise<T> =>
        withBackendPublicationConsumerLockAsync(home, async token => {
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
      }, async (storage, signal) => {
        expect(storage).toBe(project);
        expect(signal).toBe(controller.signal);
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
