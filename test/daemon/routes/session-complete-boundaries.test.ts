import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  validate: vi.fn((cwd: string) => cwd),
  migrate: vi.fn(),
  exec: vi.fn(),
  run: vi.fn(),
  close: vi.fn(),
  send: vi.fn(),
}));

vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    exec = mocks.exec;
    close = mocks.close;
    prepare() { return { run: mocks.run }; }
  },
}));
vi.mock("../../../src/daemon/project.js", () => ({
  ensureProjectDir: mocks.ensure,
  projectDbPath: (cwd: string) => `${cwd}/lcm.db`,
}));
vi.mock("../../../src/daemon/server.js", () => ({ sendJson: mocks.send }));
vi.mock("../../../src/db/migration.js", () => ({ runLcmMigrations: mocks.migrate }));
vi.mock("../../../src/daemon/validate-cwd.js", () => ({ validateCwd: mocks.validate }));

import { createSessionCompleteHandler } from "../../../src/daemon/routes/session-complete.js";

describe("session complete persistence boundaries", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.validate.mockImplementation((cwd: string) => cwd);
  });

  it("validates required fields and cwd failures", async () => {
    const handler = createSessionCompleteHandler();
    await handler({} as never, {} as never, "");
    expect(mocks.send).toHaveBeenLastCalledWith(expect.anything(), 400, { error: "session_id and cwd required" });
    mocks.validate.mockImplementationOnce(() => { throw new Error("bad cwd"); });
    await handler({} as never, {} as never, JSON.stringify({ session_id: "s", cwd: "/bad" }));
    expect(mocks.send).toHaveBeenLastCalledWith(expect.anything(), 400, { error: "bad cwd" });
    mocks.validate.mockImplementationOnce(() => { throw "failure"; });
    await handler({} as never, {} as never, JSON.stringify({ session_id: "s", cwd: "/bad" }));
    expect(mocks.send).toHaveBeenLastCalledWith(expect.anything(), 400, { error: "invalid cwd" });
  });

  it("upserts explicit and default message counts and always closes", async () => {
    const handler = createSessionCompleteHandler();
    const response = {} as never;
    await handler({} as never, response, JSON.stringify({ session_id: "s1", cwd: "/ok", message_count: 9 }));
    expect(mocks.run).toHaveBeenLastCalledWith("s1", 9);
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { recorded: true });
    await handler({} as never, response, JSON.stringify({ session_id: "s2", cwd: "/ok" }));
    expect(mocks.run).toHaveBeenLastCalledWith("s2", 0);
    expect(mocks.close).toHaveBeenCalledTimes(2);

    mocks.migrate.mockImplementationOnce(() => { throw new Error("migration failed"); });
    await expect(handler({} as never, response, JSON.stringify({ session_id: "s3", cwd: "/ok" })))
      .rejects.toThrow("migration failed");
    expect(mocks.close).toHaveBeenCalledTimes(3);
  });
});
