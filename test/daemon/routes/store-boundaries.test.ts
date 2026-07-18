import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";

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
  projectDbPath: (cwd: string) => `${cwd}/lcm.db`,
  projectDir: (cwd: string) => `${cwd}/project`,
}));
vi.mock("../../../src/daemon/server.js", () => ({ sendJson: mocks.send }));
vi.mock("../../../src/db/migration.js", () => ({ runLcmMigrations: mocks.migrate }));
vi.mock("../../../src/db/promoted.js", () => ({ PromotedStore: class { insert = mocks.insert; } }));
vi.mock("../../../src/scrub.js", () => ({ ScrubEngine: { forProject: mocks.forProject } }));
vi.mock("../../../src/daemon/validate-cwd.js", () => ({ validateCwd: mocks.validate }));
vi.mock("../../../src/daemon/safe-error.js", () => ({ sanitizeError: (message: string) => message }));

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
    mocks.getConnection.mockReturnValue({});
  });

  it("validates text, path sources, and typed cwd failures", async () => {
    const handler = createStoreHandler(config);
    await handler({} as never, response, "");
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "text is required" });
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
      projectId: "manual",
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
    expect(mocks.insert).toHaveBeenLastCalledWith(expect.objectContaining({ tags: ["tag"], projectId: "p", sessionId: "s", depth: 4 }));
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
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });
});
