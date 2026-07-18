import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";

const mocks = vi.hoisted(() => ({
  existsFile: vi.fn(() => true),
  getConnection: vi.fn(),
  closeConnection: vi.fn(),
  rowExists: vi.fn(() => ({ found: 1 })),
  migrate: vi.fn(),
  archive: vi.fn(),
  revive: vi.fn(),
  findStale: vi.fn(() => [] as unknown[]),
  validate: vi.fn((cwd: string) => cwd),
  send: vi.fn(),
}));

const db = { prepare: () => ({ get: mocks.rowExists }) };

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  existsSync: mocks.existsFile,
}));
vi.mock("../../../src/daemon/project.js", () => ({ projectDbPath: (cwd: string) => `${cwd}/lcm.db` }));
vi.mock("../../../src/daemon/server.js", () => ({ sendJson: mocks.send }));
vi.mock("../../../src/db/connection.js", () => ({
  getLcmConnection: mocks.getConnection,
  closeLcmConnection: mocks.closeConnection,
}));
vi.mock("../../../src/db/migration.js", () => ({ runLcmMigrations: mocks.migrate }));
vi.mock("../../../src/db/promoted.js", () => ({
  PromotedStore: class { archive = mocks.archive; revive = mocks.revive; findStale = mocks.findStale; },
}));
vi.mock("../../../src/daemon/validate-cwd.js", () => ({ validateCwd: mocks.validate }));

import { createReviewStaleHandler } from "../../../src/daemon/routes/review-stale.js";

const config = loadDaemonConfig("/tmp/review-stale-boundaries");
const response = {} as never;

describe("review-stale persistence boundaries", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.existsFile.mockReturnValue(true);
    mocks.getConnection.mockReturnValue(db);
    mocks.rowExists.mockReturnValue({ found: 1 });
    mocks.findStale.mockReturnValue([]);
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
    mocks.existsFile.mockReturnValue(false);
    await createReviewStaleHandler(config)({} as never, response, JSON.stringify({ cwd: "/missing" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { stale: [], total: 0 });
  });

  it("validates actions and handles archive and revive", async () => {
    const handler = createReviewStaleHandler(config);
    await handler({} as never, response, JSON.stringify({ cwd: "/ok", action: "unknown", target_id: "id" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: 'Unknown action: unknown. Use "archive" or "revive".' });
    mocks.rowExists.mockReturnValueOnce(undefined);
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
    mocks.findStale.mockReturnValueOnce([{
      id: "id", content: "memory", tags: '["tag"]', project_id: "p", confidence: 0.8,
      created_at: "2025", daysSinceCreated: 10, surfacingCount: 3, usageCount: 0,
    }]);
    await createReviewStaleHandler(config)({} as never, response, JSON.stringify({ cwd: "/ok", project_id: "p" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, {
      stale: [{ id: "id", content: "memory", tags: ["tag"], projectId: "p", confidence: 0.8,
        createdAt: "2025", daysSinceCreated: 10, surfacingCount: 3, usageCount: 0 }],
      total: 1,
    });
    expect(mocks.findStale).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: "p" }));
  });

  it("normalizes typed and untyped failures and only closes opened handles", async () => {
    const handler = createReviewStaleHandler(config);
    mocks.getConnection.mockImplementationOnce(() => { throw new Error("open failed"); });
    await handler({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "open failed" });
    expect(mocks.closeConnection).not.toHaveBeenCalled();
    mocks.findStale.mockImplementationOnce(() => { throw "failure"; });
    await handler({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "review-stale failed" });
    expect(mocks.closeConnection).toHaveBeenLastCalledWith("/ok/lcm.db");
  });
});
