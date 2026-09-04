import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { StorageOperationError } from "../../../src/storage/errors.js";
import type { StorageBackendFactory } from "../../../src/storage/index.js";
import { makeStagedPostgreSqlStorageFactory } from "./mock-storage-factory.js";

const mocks = vi.hoisted(() => ({
  stat: vi.fn(() => ({ mtimeMs: 1 })),
  getConnection: vi.fn(),
  close: vi.fn(),
  insert: vi.fn(() => "stored-id"),
  scrub: vi.fn((text: string) => `scrubbed:${text}`),
  forProject: vi.fn(async () => ({ scrub: mocks.scrub })),
  validate: vi.fn((cwd: string) => cwd),
  migrate: vi.fn(),
  send: vi.fn(),
  openProject: vi.fn(),
  projectClose: vi.fn(async () => undefined),
  factoryClose: vi.fn(async () => undefined),
  identity: vi.fn((cwd: string) => ({
    id: `pid-${cwd}`,
    localProjectId: `pid-${cwd}`,
    canonical: cwd,
    machineId: "machine-id",
    selectedPath: cwd,
  })),
  pathsForIdentity: vi.fn((identity: { id: string; canonical: string; remoteProjectId?: string }) => ({
    ...identity,
    dir: `/lcm/projects/${identity.id}`,
    dbPath: `/lcm/projects/${identity.id}/db.sqlite`,
    metaPath: `/lcm/projects/${identity.id}/meta.json`,
  })),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  statSync: mocks.stat,
}));
vi.mock("../../../src/db/connection.js", () => ({
  getLcmConnection: mocks.getConnection,
  closeLcmConnection: mocks.close,
}));
vi.mock("../../../src/daemon/project.js", () => ({
  projectDir: (cwd: string) => `${cwd}/project`,
  projectIdentity: mocks.identity,
  projectPathsForIdentity: mocks.pathsForIdentity,
}));
vi.mock("../../../src/daemon/server.js", () => ({ sendJson: mocks.send }));
vi.mock("../../../src/db/migration.js", () => ({ runLcmMigrations: mocks.migrate }));
vi.mock("../../../src/db/promoted.js", () => ({ PromotedStore: class { insert = mocks.insert; } }));
vi.mock("../../../src/scrub.js", () => ({ ScrubEngine: { forProject: mocks.forProject } }));
vi.mock("../../../src/daemon/validate-cwd.js", () => ({ validateCwd: mocks.validate }));
vi.mock("../../../src/daemon/safe-error.js", () => ({ sanitizeError: (message: string) => message }));
vi.mock("../../../src/storage/index.js", () => ({
  createStorageBackendFactory: async () => ({
    openProject: mocks.openProject,
    close: mocks.factoryClose,
  }),
}));

import { createStoreHandler } from "../../../src/daemon/routes/store.js";

const config = loadDaemonConfig("/tmp/store-boundaries");
const response = {} as never;

describe("store persistence boundaries", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.stat.mockReturnValue({ mtimeMs: 1 });
    mocks.insert.mockReturnValue("stored-id");
    mocks.scrub.mockImplementation((text: string) => `scrubbed:${text}`);
    mocks.forProject.mockImplementation(async () => ({ scrub: mocks.scrub }));
    mocks.validate.mockImplementation((cwd: string) => cwd);
    mocks.identity.mockImplementation((cwd: string) => ({
      id: `pid-${cwd}`,
      localProjectId: `pid-${cwd}`,
      canonical: cwd,
      machineId: "machine-id",
      selectedPath: cwd,
    }));
    mocks.pathsForIdentity.mockImplementation(identity => ({
      ...identity,
      dir: `/lcm/projects/${identity.id}`,
      dbPath: `/lcm/projects/${identity.id}/db.sqlite`,
      metaPath: `/lcm/projects/${identity.id}/meta.json`,
    }));
    mocks.getConnection.mockReturnValue({});
    mocks.openProject.mockResolvedValue({
      promotedMemory: { insert: mocks.insert },
      close: mocks.projectClose,
    });
  });

  it("validates text, path sources, and typed cwd failures", async () => {
    const handler = createStoreHandler(config);
    await handler({} as never, response, "");
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "text is required" });
    await handler({} as never, response, JSON.stringify({ text: "value", tags: "invalid" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "tags must be an array of strings" });
    await handler({} as never, response, JSON.stringify({ text: "value", tags: [1] }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "tags must be an array of strings" });
    await handler({} as never, response, JSON.stringify({ text: "value" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "cwd or metadata.projectPath is required" });
    mocks.validate.mockImplementationOnce(() => { throw new Error("bad cwd"); });
    await handler({} as never, response, JSON.stringify({ text: "value", cwd: "/bad" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "bad cwd" });
    mocks.validate.mockImplementationOnce(() => { throw "failure"; });
    await handler({} as never, response, JSON.stringify({ text: "value", metadata: { projectPath: "/bad" } }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "invalid cwd" });
  });

  it("uses defaults, metadata, cached scrubbers, and mtime invalidation", async () => {
    const handler = createStoreHandler(config);
    await handler({} as never, response, JSON.stringify({ text: "one", metadata: { projectPath: "/metadata" } }));
    expect(mocks.insert).toHaveBeenLastCalledWith({
      content: "scrubbed:one",
      tags: [],
      sourceProjectId: "manual",
      sessionId: "manual",
      depth: 0,
      confidence: 1,
    });
    await handler({} as never, response, JSON.stringify({ text: "two", cwd: "/metadata" }));
    expect(mocks.forProject).toHaveBeenCalledTimes(1);
    mocks.stat.mockReturnValue({ mtimeMs: 2 });
    await handler({} as never, response, JSON.stringify({
      text: "three",
      cwd: "/metadata",
      tags: ["tag"],
      metadata: { projectId: "p", sessionId: "s", depth: 4 },
    }));
    expect(mocks.forProject).toHaveBeenCalledTimes(2);
    expect(mocks.insert).toHaveBeenLastCalledWith(expect.objectContaining({ tags: ["scrubbed:tag"], sessionId: "s", depth: 4 }));
    expect(mocks.insert.mock.calls.at(-1)?.[0]).toMatchObject({ sourceProjectId: "p" });
  });

  it("handles absent pattern files and evicts the oldest scrubber at capacity", async () => {
    mocks.stat.mockImplementation(() => { throw new Error("missing"); });
    const noSecurityConfig = { ...config, security: undefined };
    const handler = createStoreHandler(noSecurityConfig);
    for (let index = 0; index <= 100; index++) {
      await handler({} as never, response, JSON.stringify({ text: "value", cwd: `/evict-${index}` }));
    }
    expect(mocks.forProject).toHaveBeenCalledWith([], expect.any(String));
    expect(mocks.forProject).toHaveBeenCalledTimes(101);
  });

  it("returns sanitized typed and untyped persistence failures and closes", async () => {
    const handler = createStoreHandler(config);
    mocks.insert.mockImplementationOnce(() => { throw new Error("insert failed"); });
    await handler({} as never, response, JSON.stringify({ text: "value", cwd: "/error-one" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "insert failed" });
    mocks.insert.mockImplementationOnce(() => { throw "failure"; });
    await handler({} as never, response, JSON.stringify({ text: "value", cwd: "/error-two" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "store failed" });
    expect(mocks.projectClose).toHaveBeenCalledTimes(2);
    expect(mocks.factoryClose).toHaveBeenCalledTimes(2);
  });

  it("resolves storage identity before reading project scrub patterns", async () => {
    const handler = createStoreHandler(config);
    mocks.identity.mockImplementationOnce(() => { throw new Error("identity failed"); });

    await handler({} as never, response, JSON.stringify({ text: "value", cwd: "/unbound" }));

    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "identity failed" });
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.forProject).not.toHaveBeenCalled();
    expect(mocks.openProject).not.toHaveBeenCalled();
  });

  it("returns a structured error without closing when acquisition fails", async () => {
    const handler = createStoreHandler(config);
    mocks.openProject.mockRejectedValueOnce(new Error("open failed"));

    await handler({} as never, response, JSON.stringify({ text: "value", cwd: "/open-error" }));

    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "open failed" });
    expect(mocks.projectClose).not.toHaveBeenCalled();
    expect(mocks.factoryClose).toHaveBeenCalledOnce();
  });

  it("does not report a cancelled create as stored after project open", async () => {
    const handler = createStoreHandler(config);
    const controller = new AbortController();
    mocks.openProject.mockImplementationOnce(async () => {
      controller.abort();
      return {
        promotedMemory: { insert: mocks.insert },
        close: mocks.projectClose,
      };
    });

    await handler(
      {} as never,
      response,
      JSON.stringify({ text: "cancelled", cwd: "/cancelled" }),
      { signal: controller.signal },
    );

    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "request cancelled" });
    expect(mocks.send.mock.calls.some(([, status, body]) => status === 200 && body?.stored === true)).toBe(false);
    expect(mocks.projectClose).toHaveBeenCalledOnce();
  });

  it("returns staged PostgreSQL unavailability before scrubber discovery", async () => {
    const postgresqlConfig = {
      ...config,
      storage: {
        backend: "postgresql",
        postgresql: {
          url: "postgresql://user:secret@db.example/lcm",
          poolMax: 1,
          connectionTimeoutMs: 100,
          idleTimeoutMs: 100,
          statementTimeoutMs: 100,
        },
      },
    } as const;
    const handler = createStoreHandler(postgresqlConfig, makeStagedPostgreSqlStorageFactory());

    await handler({} as never, response, JSON.stringify({ text: "value", cwd: "/staged" }));

    expect(mocks.send).toHaveBeenLastCalledWith(response, 503, expect.objectContaining({
      code: "STORAGE_BACKEND_STAGED",
      error: "store is unavailable while PostgreSQL storage repositories are staged",
      storageBackend: "postgresql",
    }));
    expect(mocks.forProject).not.toHaveBeenCalled();
  });

  it("maps typed PostgreSQL persistence failures to sanitized 503 responses", async () => {
    const postgresqlConfig = {
      ...config,
      storage: {
        backend: "postgresql",
        postgresql: {
          url: "postgresql://user:secret@db.example/lcm",
          poolMax: 1,
          connectionTimeoutMs: 100,
          idleTimeoutMs: 100,
          statementTimeoutMs: 100,
        },
      },
    } as const;
    const injected = {
      backend: "postgresql",
      capabilities: {
        transactions: true,
        lexicalSearch: true,
        regexSearch: true,
        nativeFullTextSearch: "available",
        coordination: "distributed",
      },
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    } as unknown as StorageBackendFactory;
    const error = new StorageOperationError(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      "pid",
      "promotedMemory",
      "insert",
    );
    mocks.insert.mockImplementationOnce(() => { throw error; });

    await createStoreHandler(postgresqlConfig, injected)(
      {} as never,
      response,
      JSON.stringify({ text: "value", cwd: "/typed-error" }),
    );

    expect(mocks.send).toHaveBeenLastCalledWith(response, 503, error.toJSON());
  });

  it("uses an injected factory without taking ownership of it", async () => {
    const injected = { openProject: mocks.openProject, close: mocks.factoryClose } as never;
    const handler = createStoreHandler(config, injected);
    await handler({} as never, response, JSON.stringify({ text: "value", cwd: "/injected" }));
    expect(mocks.insert).toHaveBeenCalledOnce();
    expect(mocks.projectClose).toHaveBeenCalledOnce();
    expect(mocks.factoryClose).not.toHaveBeenCalled();
  });

  it("keeps the successful response when project and factory cleanup reject", async () => {
    mocks.projectClose.mockRejectedValueOnce(new Error("project close failed"));
    mocks.factoryClose.mockRejectedValueOnce(new Error("factory close failed"));
    const sendsBefore = mocks.send.mock.calls.length;
    await createStoreHandler(config)({} as never, response, JSON.stringify({ text: "value", cwd: "/close-error" }));
    expect(mocks.send).toHaveBeenCalledTimes(sendsBefore + 1);
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { stored: true, id: "stored-id" });
  });

  it("does scrubber work before admission and keeps the repository write inside it", async () => {
    const order: string[] = [];
    mocks.forProject.mockImplementationOnce(async () => {
      order.push("scrubber");
      return { scrub: (text: string) => { order.push("scrub"); return `scrubbed:${text}`; } };
    });
    mocks.insert.mockImplementationOnce(() => { order.push("insert"); return "stored-id"; });
    const admission = vi.fn(async (operation: (token: object) => Promise<unknown>) => {
      order.push("admission");
      return operation({});
    });

    await createStoreHandler(config)({} as never, response, JSON.stringify({ text: "value", cwd: "/ordered" }), {
      withPublicationAdmission: admission,
      signal: new AbortController().signal,
    });

    expect(order).toEqual(["scrubber", "scrub", "admission", "insert"]);
    expect(admission).toHaveBeenCalledOnce();
  });

  it("blocks live identity drift after selecting scrubber patterns from the preflight identity", async () => {
    const preflight = {
      id: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
      localProjectId: "local-hash-a",
      canonical: "/work/project",
      remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
      machineId: "machine-id",
      selectedPath: "/work/project",
    };
    const live = {
      ...preflight,
      id: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9021",
      remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9021",
    };
    mocks.identity.mockReturnValueOnce(preflight).mockReturnValueOnce(live);
    const order: string[] = [];
    mocks.forProject.mockImplementationOnce(async () => {
      order.push("scrubber");
      return { scrub: mocks.scrub };
    });
    const admission = vi.fn(async (operation: (token: object) => Promise<unknown>) => {
      order.push("admission");
      return operation({});
    });

    await createStoreHandler(config)(
      {} as never,
      response,
      JSON.stringify({ text: "value", cwd: preflight.canonical }),
      { withPublicationAdmission: admission, signal: new AbortController().signal },
    );

    expect(mocks.pathsForIdentity).toHaveBeenCalledWith({
      id: preflight.localProjectId,
      canonical: preflight.canonical,
      remoteProjectId: preflight.remoteProjectId,
    });
    expect(mocks.forProject).toHaveBeenCalledWith(
      config.security.sensitivePatterns,
      `/lcm/projects/${preflight.localProjectId}`,
    );
    expect(order).toEqual(["scrubber", "admission"]);
    expect(mocks.send).toHaveBeenLastCalledWith(response, 503, {
      status: "blocked",
      error: "backend publication admission blocked",
    });
    expect(mocks.openProject).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("passes the matching preflight identity through the live storage open", async () => {
    const identity = {
      id: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
      localProjectId: "local-hash-same",
      canonical: "/work/same",
      remoteProjectId: "018f22c4-6d2a-7f10-8a4c-6b8d3e5f9020",
      machineId: "machine-id",
      selectedPath: "/work/same",
    };
    mocks.identity.mockReturnValue(identity);

    await createStoreHandler(config)(
      {} as never,
      response,
      JSON.stringify({ text: "value", cwd: identity.canonical }),
      { withPublicationAdmission: operation => operation({}) },
    );

    expect(mocks.openProject).toHaveBeenCalledWith(identity, expect.any(Object), expect.any(AbortSignal));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { stored: true, id: "stored-id" });
  });
});
