import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonConfig, ResolvedStorageConfig } from "../../src/daemon/config.js";
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
import { UNBOUND_POSTGRESQL_PROJECT_MESSAGE } from "../../src/storage/identity-context.js";

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
    });
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

  it("validates PostgreSQL identity before constructing the unavailable default factory", async () => {
    resolveProjectIdentity(cwd);
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
});
