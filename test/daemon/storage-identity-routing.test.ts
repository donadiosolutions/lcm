import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonConfig, ResolvedStorageConfig } from "../../src/daemon/config.js";
import {
  createCompactHandler as createCompactHandlerProduction,
} from "../../src/daemon/routes/compact.js";
import type {
  RouteExecutionContext,
  RouteHandler,
  RoutePublicationAdmission,
} from "../../src/daemon/server.js";
import { createIngestHandler } from "../../src/daemon/routes/ingest.js";
import { createStoreHandler } from "../../src/daemon/routes/store.js";
import {
  recoverMachineIdentity,
  type MachineIdentity,
} from "../../src/machine-identity.js";
import {
  clearProjectMapCache,
  resolveProjectIdentity,
  setRemoteProjectBinding,
} from "../../src/project-map.js";
import type {
  ProjectStorage,
  StorageBackendFactory,
  StorageIdentityContext,
} from "../../src/storage/index.js";
import * as storageFactoryModule from "../../src/storage/factory.js";
import { UNBOUND_POSTGRESQL_PROJECT_MESSAGE } from "../../src/storage/identity-context.js";
import { withBackendPublicationConsumerLockAsync } from "../../src/storage/backend-publication.js";
import { makeStagedPostgreSqlStorageFactory } from "./routes/mock-storage-factory.js";

const testPublicationAdmission: RoutePublicationAdmission = operation =>
  withBackendPublicationConsumerLockAsync(process.env.HOME, operation, { allowUnresolved: true });
const testCompactContext: RouteExecutionContext = {
  withPublicationAdmission: testPublicationAdmission,
};

function createCompactHandler(
  config: DaemonConfig,
  factory?: StorageBackendFactory,
): RouteHandler {
  const handler = createCompactHandlerProduction(config, factory);
  return (req, res, body, context = testCompactContext) => handler(req, res, body, context);
}

const MACHINE_ID = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9012";
const PROJECT_ID = "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020";
const POSTGRESQL_STORAGE: ResolvedStorageConfig = {
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

describe("daemon storage identity routing", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lcm-storage-routing-"));
    cwd = join(home, "project");
    mkdirSync(cwd);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    clearProjectMapCache();
  });

  afterEach(() => {
    clearProjectMapCache();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  it("passes remote, machine, local-hash, and canonical identities to injected factories", async () => {
    const machine: MachineIdentity = {
      version: 1,
      identityKey: `machine:${"a".repeat(64)}`,
      machineId: MACHINE_ID,
      displayName: "Machine A",
    };
    recoverMachineIdentity(machine, { homeDir: home });
    const local = resolveProjectIdentity(cwd);
    setRemoteProjectBinding(PROJECT_ID, { hash: local.id });
    const openProject = vi.fn(async (_identity: StorageIdentityContext) => ({
      promotedMemory: { insert: vi.fn(async () => "stored-id") },
      close: vi.fn(async () => undefined),
    } as unknown as ProjectStorage));
    const factory = {
      openProject,
      close: vi.fn(async () => undefined),
    } as unknown as StorageBackendFactory;
    const response = {
      writeHead: vi.fn(),
      end: vi.fn(),
    };
    const config = {
      storage: POSTGRESQL_STORAGE,
      security: { sensitivePatterns: [], notify_on_filter: false },
    } as unknown as DaemonConfig;

    await createStoreHandler(config, factory)(
      {} as never,
      response as never,
      JSON.stringify({ text: "remember", cwd }),
    );

    expect(openProject).toHaveBeenCalledWith({
      id: PROJECT_ID,
      localProjectId: local.id,
      canonical: cwd,
      remoteProjectId: PROJECT_ID,
      machineId: MACHINE_ID,
    }, undefined, expect.any(AbortSignal));
    expect(response.writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "application/json",
    });
  });

  it("fails closed before an injected PostgreSQL factory sees an unbound project", async () => {
    const local = resolveProjectIdentity(cwd);
    const openProject = vi.fn();
    const factory = {
      openProject,
      close: vi.fn(async () => undefined),
    } as unknown as StorageBackendFactory;
    const response = {
      writeHead: vi.fn(),
      end: vi.fn(),
    };
    const config = {
      storage: POSTGRESQL_STORAGE,
      security: { sensitivePatterns: [], notify_on_filter: false },
    } as unknown as DaemonConfig;

    await createStoreHandler(config, factory)(
      {} as never,
      response as never,
      JSON.stringify({ text: "remember", cwd }),
    );

    expect(openProject).not.toHaveBeenCalled();
    expect(response.end).toHaveBeenCalledWith(JSON.stringify({
      code: "STORAGE_IDENTITY_REQUIRED",
      error: UNBOUND_POSTGRESQL_PROJECT_MESSAGE,
      storageBackend: "postgresql",
    }));
    expect(UNBOUND_POSTGRESQL_PROJECT_MESSAGE).not.toContain(local.id);
    expect(UNBOUND_POSTGRESQL_PROJECT_MESSAGE).not.toContain(cwd);
  });

  it("validates PostgreSQL identity before opening the injected factory", async () => {
    resolveProjectIdentity(cwd);
    vi.spyOn(storageFactoryModule, "createStorageBackendFactory")
      .mockResolvedValue(makeStagedPostgreSqlStorageFactory());
    const response = {
      writeHead: vi.fn(),
      end: vi.fn(),
    };
    const config = {
      storage: POSTGRESQL_STORAGE,
      security: { sensitivePatterns: [], notify_on_filter: false },
    } as unknown as DaemonConfig;

    await createStoreHandler(config)(
      {} as never,
      response as never,
      JSON.stringify({ text: "remember", cwd }),
    );

    expect(response.end).toHaveBeenCalledWith(JSON.stringify({
      code: "STORAGE_IDENTITY_REQUIRED",
      error: UNBOUND_POSTGRESQL_PROJECT_MESSAGE,
      storageBackend: "postgresql",
    }));
    expect(response.end).not.toHaveBeenCalledWith(expect.stringContaining(
      "not available in this release",
    ));
  });

  it("admits disabled compaction and empty ingest through PostgreSQL identity and staging", async () => {
    const machine: MachineIdentity = {
      version: 1,
      identityKey: `machine:${"a".repeat(64)}`,
      machineId: MACHINE_ID,
      displayName: "Machine A",
    };
    recoverMachineIdentity(machine, { homeDir: home });
    const local = resolveProjectIdentity(cwd);
    const response = {
      writeHead: vi.fn(),
      end: vi.fn(),
    };
    const config = {
      storage: POSTGRESQL_STORAGE,
      llm: { provider: "disabled" },
      security: { sensitivePatterns: [], notify_on_filter: false },
    } as unknown as DaemonConfig;

    await createCompactHandler(config, makeStagedPostgreSqlStorageFactory())(
      {} as never,
      response as never,
      JSON.stringify({ session_id: "disabled", cwd }),
    );
    expect(response.end).toHaveBeenLastCalledWith(JSON.stringify({
      code: "STORAGE_IDENTITY_REQUIRED",
      error: UNBOUND_POSTGRESQL_PROJECT_MESSAGE,
      storageBackend: "postgresql",
    }));

    setRemoteProjectBinding(PROJECT_ID, { hash: local.id });
    response.end.mockClear();
    await createCompactHandler(config, makeStagedPostgreSqlStorageFactory())(
      {} as never,
      response as never,
      JSON.stringify({ session_id: "disabled", cwd }),
    );
    expect(response.end).toHaveBeenLastCalledWith(expect.stringContaining(
      "\"code\":\"STORAGE_BACKEND_STAGED\"",
    ));

    response.end.mockClear();
    await createIngestHandler(config, makeStagedPostgreSqlStorageFactory())(
      {} as never,
      response as never,
      JSON.stringify({ session_id: "empty", cwd, messages: [] }),
    );
    expect(response.end).toHaveBeenLastCalledWith(expect.stringContaining(
      "\"code\":\"STORAGE_BACKEND_STAGED\"",
    ));
  });

  it("returns staged compact and store failures before legacy metadata or scrub I/O", async () => {
    recoverMachineIdentity({
      version: 1,
      identityKey: `machine:${"a".repeat(64)}`,
      machineId: MACHINE_ID,
      displayName: "Machine A",
    }, { homeDir: home });
    const local = resolveProjectIdentity(cwd);
    setRemoteProjectBinding(PROJECT_ID, { hash: local.id });
    const localProjectDir = join(home, ".lcm", "projects", local.id);
    mkdirSync(join(localProjectDir, "sensitive-patterns.txt"), { recursive: true });
    const response = {
      writeHead: vi.fn(),
      end: vi.fn(),
    };
    const config = {
      storage: POSTGRESQL_STORAGE,
      llm: { provider: "disabled" },
      security: { sensitivePatterns: [], notify_on_filter: false },
    } as unknown as DaemonConfig;

    await createCompactHandler(config, makeStagedPostgreSqlStorageFactory())(
      {} as never,
      response as never,
      JSON.stringify({ session_id: "staged-before-local-io", cwd }),
    );
    expect(response.end).toHaveBeenLastCalledWith(expect.stringContaining(
      "\"code\":\"STORAGE_BACKEND_STAGED\"",
    ));
    expect(existsSync(join(localProjectDir, "meta.json"))).toBe(false);

    response.end.mockClear();
    await createStoreHandler(config, makeStagedPostgreSqlStorageFactory())(
      {} as never,
      response as never,
      JSON.stringify({ text: "remember", cwd }),
    );
    expect(response.end).toHaveBeenLastCalledWith(expect.stringContaining(
      "\"code\":\"STORAGE_BACKEND_STAGED\"",
    ));
    expect(response.end).not.toHaveBeenCalledWith(expect.stringContaining("\"code\":500"));
    expect(existsSync(join(localProjectDir, "meta.json"))).toBe(false);
  });

  it("uses and closes the default factory for admitted PostgreSQL no-ops", async () => {
    recoverMachineIdentity({
      version: 1,
      identityKey: `machine:${"a".repeat(64)}`,
      machineId: MACHINE_ID,
      displayName: "Machine A",
    }, { homeDir: home });
    const local = resolveProjectIdentity(cwd);
    setRemoteProjectBinding(PROJECT_ID, { hash: local.id });
    const closeProject = vi.fn(async () => undefined);
    const openProject = vi.fn(async () => ({
      close: closeProject,
    } as unknown as ProjectStorage));
    const closeFactory = vi.fn(async () => undefined);
    const factory = {
      openProject,
      close: closeFactory,
    } as unknown as StorageBackendFactory;
    vi.spyOn(storageFactoryModule, "createStorageBackendFactory")
      .mockResolvedValue(factory);
    const response = {
      writeHead: vi.fn(),
      end: vi.fn(),
    };
    const config = {
      storage: POSTGRESQL_STORAGE,
      llm: { provider: "disabled" },
      security: { sensitivePatterns: [], notify_on_filter: false },
    } as unknown as DaemonConfig;

    await createCompactHandler(config)(
      {} as never,
      response as never,
      JSON.stringify({ session_id: "disabled-default", cwd }),
    );
    expect(response.end).toHaveBeenLastCalledWith(expect.stringContaining(
      "\"actionTaken\":false",
    ));
    expect(closeProject).toHaveBeenCalledTimes(1);
    expect(closeFactory).toHaveBeenCalledTimes(1);

    response.end.mockClear();
    await createIngestHandler(config)(
      {} as never,
      response as never,
      JSON.stringify({ session_id: "empty-default", cwd, messages: [] }),
    );
    expect(response.end).toHaveBeenLastCalledWith(JSON.stringify({
      ingested: 0,
      totalTokens: 0,
    }));
    expect(closeProject).toHaveBeenCalledTimes(2);
    expect(closeFactory).toHaveBeenCalledTimes(2);
  });
});
