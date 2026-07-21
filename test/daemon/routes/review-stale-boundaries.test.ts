import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";

const mocks = vi.hoisted(() => ({
  existsFile: vi.fn(() => true),
  getById: vi.fn(async () => ({ id: "id" } as unknown)),
  archive: vi.fn(async () => undefined),
  revive: vi.fn(async () => undefined),
  findStale: vi.fn(async () => [] as unknown[]),
  projectClose: vi.fn(async () => undefined),
  factoryClose: vi.fn(async () => undefined),
  openProject: vi.fn(),
  createFactory: vi.fn(),
  projectExists: vi.fn(async () => true),
  validate: vi.fn((cwd: string) => cwd),
  send: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  existsSync: mocks.existsFile,
}));
vi.mock("../../../src/daemon/project.js", () => ({
  projectDbPath: (cwd: string) => `${cwd}/lcm.db`,
  projectIdentity: (cwd: string) => ({ id: cwd, canonical: cwd }),
}));
vi.mock("../../../src/daemon/server.js", () => ({ sendJson: mocks.send }));
vi.mock("../../../src/storage/index.js", () => ({ createStorageBackendFactory: mocks.createFactory }));
vi.mock("../../../src/daemon/validate-cwd.js", () => ({ validateCwd: mocks.validate }));

import { createReviewStaleHandler } from "../../../src/daemon/routes/review-stale.js";

const config = loadDaemonConfig("/tmp/review-stale-boundaries");
const response = {} as never;

describe("review-stale persistence boundaries", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.existsFile.mockReturnValue(true);
    mocks.projectExists.mockResolvedValue(true);
    mocks.getById.mockResolvedValue({ id: "id" });
    mocks.findStale.mockResolvedValue([]);
    mocks.openProject.mockResolvedValue({
      promotedMemory: { getById: mocks.getById, archive: mocks.archive, revive: mocks.revive, findStale: mocks.findStale },
      close: mocks.projectClose,
    });
    mocks.createFactory.mockReturnValue({ projectExists: mocks.projectExists, openProject: mocks.openProject, close: mocks.factoryClose });
    mocks.validate.mockImplementation((cwd: string) => cwd);
  });

  it("validates JSON, required cwd, and typed cwd failures", async () => {
    const handler = createReviewStaleHandler(config);
    await handler({} as never, response, "{");
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "Invalid JSON body" });
    await handler({} as never, response, "");
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "cwd is required" });
    mocks.validate.mockImplementationOnce(() => { throw new Error("bad cwd"); });
    await handler({} as never, response, JSON.stringify({ cwd: "/bad" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "bad cwd" });
    mocks.validate.mockImplementationOnce(() => { throw "failure"; });
    await handler({} as never, response, JSON.stringify({ cwd: "/bad" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "invalid cwd" });
  });

  it("returns an empty result for missing databases", async () => {
    mocks.projectExists.mockResolvedValue(false);
    await createReviewStaleHandler(config)({} as never, response, JSON.stringify({ cwd: "/missing" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { stale: [], total: 0 });
  });

  it("validates actions and handles archive and revive", async () => {
    const handler = createReviewStaleHandler(config);
    await handler({} as never, response, JSON.stringify({ cwd: "/ok", action: "unknown", target_id: "id" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: 'Unknown action: unknown. Use "archive" or "revive".' });
    mocks.getById.mockResolvedValueOnce(null);
    await handler({} as never, response, JSON.stringify({ cwd: "/ok", action: "archive", target_id: "missing" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 404, { error: "Memory missing not found" });
    await handler({} as never, response, JSON.stringify({ cwd: "/ok", action: "archive", target_id: "id" }));
    expect(mocks.archive).toHaveBeenLastCalledWith("id");
    await handler({} as never, response, JSON.stringify({ cwd: "/ok", action: "revive", target_id: "id" }));
    expect(mocks.revive).toHaveBeenLastCalledWith("id");
    await handler({} as never, response, JSON.stringify({ cwd: "/ok", action: "archive" }));
    expect(mocks.findStale).toHaveBeenCalled();
  });

  it("maps stale rows and project filters", async () => {
    mocks.findStale.mockResolvedValueOnce([{
      id: "id", content: "memory", tags: ["tag"], projectId: "p", confidence: 0.8,
      createdAt: "2025", daysSinceCreated: 10, surfacingCount: 3, usageCount: 0,
    }]);
    await createReviewStaleHandler(config)({} as never, response, JSON.stringify({ cwd: "/ok", project_id: "p" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, {
      stale: [{ id: "id", content: "memory", tags: ["tag"], projectId: "p", confidence: 0.8,
        createdAt: "2025", daysSinceCreated: 10, surfacingCount: 3, usageCount: 0 }],
      total: 1,
    });
    expect(mocks.findStale).toHaveBeenLastCalledWith({
      staleAfterDays: config.restoration.staleAfterDays,
      staleSurfacingWithoutUseLimit: config.restoration.staleSurfacingWithoutUseLimit,
      sourceProjectId: "p",
    });
    const closeCount = mocks.factoryClose.mock.calls.length;
    await createReviewStaleHandler(config, {
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    } as never)({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.factoryClose).toHaveBeenCalledTimes(closeCount);
  });

  it("normalizes typed and untyped failures and only closes opened handles", async () => {
    const handler = createReviewStaleHandler(config);
    mocks.openProject.mockRejectedValueOnce(new Error("open failed"));
    await handler({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "open failed" });
    expect(mocks.projectClose).not.toHaveBeenCalled();
    expect(mocks.factoryClose).toHaveBeenCalled();
    mocks.findStale.mockRejectedValueOnce("failure");
    await handler({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "review-stale failed" });
    expect(mocks.projectClose).toHaveBeenCalled();
  });
});
