import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { StorageOperationError } from "../../../src/storage/errors.js";

const mocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  validate: vi.fn((cwd: string) => cwd),
  migrate: vi.fn(),
  getConnection: vi.fn(),
  run: vi.fn(),
  storedGet: vi.fn(() => ({ message_count: 7 }) as { message_count: number } | undefined),
  close: vi.fn(),
  send: vi.fn(),
  lock: vi.fn(async (_path: string, work: () => unknown) => work()),
}));

vi.mock("../../../src/db/connection.js", () => ({
  getLcmConnection: mocks.getConnection,
  closeLcmConnection: mocks.close,
  withLcmConnectionLock: mocks.lock,
}));
vi.mock("../../../src/daemon/project.js", () => ({
  projectIdentity: (cwd: string) => ({ id: cwd, canonical: cwd }),
}));
vi.mock("../../../src/daemon/server.js", () => ({ sendJson: mocks.send }));
vi.mock("../../../src/db/migration.js", () => ({ runLcmMigrations: mocks.migrate }));
vi.mock("../../../src/daemon/validate-cwd.js", () => ({ validateCwd: mocks.validate }));
vi.mock("../../../src/storage/index.js", () => ({
  createStorageBackendFactory: async () => ({
    openProject: async () => {
      mocks.getConnection();
      try {
        mocks.migrate();
      } catch (error) {
        mocks.close();
        throw error;
      }
      const conversations = {
        getMessageCountBySessionId: async () => mocks.storedGet()?.message_count ?? 0,
      };
      const coordination = { recordSessionIngest: mocks.run };
      const repositories = { conversations, coordination };
      return {
        ...repositories,
        transaction: async (operation: (value: typeof repositories) => Promise<unknown>) => operation(repositories),
        close: async () => { mocks.close(); },
      };
    },
    close: async () => undefined,
  }),
}));

import { createSessionCompleteHandler } from "../../../src/daemon/routes/session-complete.js";

const config = loadDaemonConfig("/tmp/session-complete-boundaries");

describe("session complete persistence boundaries", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.validate.mockImplementation((cwd: string) => cwd);
    mocks.getConnection.mockReturnValue({
      prepare: (sql: string) => sql.includes("COUNT(m.message_id)")
        ? { get: mocks.storedGet }
        : { run: mocks.run },
    });
  });

  it("validates required fields and cwd failures", async () => {
    const handler = createSessionCompleteHandler(config);
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
    const handler = createSessionCompleteHandler(config);
    const response = {} as never;
    await handler({} as never, response, JSON.stringify({ session_id: "s1", cwd: "/ok", message_count: 9 }));
    expect(mocks.run).toHaveBeenLastCalledWith("s1", 7);
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { recorded: true });
    await handler({} as never, response, JSON.stringify({ session_id: "s2", cwd: "/ok" }));
    expect(mocks.run).toHaveBeenLastCalledWith("s2", 7);
    mocks.storedGet.mockReturnValueOnce(undefined);
    await handler({} as never, response, JSON.stringify({ session_id: "s-empty", cwd: "/ok" }));
    expect(mocks.run).toHaveBeenLastCalledWith("s-empty", 0);
    expect(mocks.close).toHaveBeenCalledTimes(3);

    mocks.migrate.mockImplementationOnce(() => {
      throw new Error("migration failed at /srv/private/session.db");
    });
    await handler({} as never, response, JSON.stringify({ session_id: "s3", cwd: "/ok" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, {
      error: "migration failed at <path>",
    });
    expect(JSON.stringify(mocks.send.mock.lastCall)).not.toContain("/srv/private/session.db");
    mocks.migrate.mockImplementationOnce(() => { throw "failure"; });
    await handler({} as never, response, JSON.stringify({ session_id: "s4", cwd: "/ok" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "session completion failed" });
    expect(mocks.close).toHaveBeenCalledTimes(5);
  });

  it("returns a structured error without closing when acquisition fails", async () => {
    const handler = createSessionCompleteHandler(config);
    const response = {} as never;
    mocks.getConnection.mockImplementationOnce(() => { throw new Error("open failed"); });

    await handler({} as never, response, JSON.stringify({ session_id: "s", cwd: "/ok" }));

    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "open failed" });
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("does not report a cancelled create as recorded after project open", async () => {
    const handler = createSessionCompleteHandler(config);
    const response = {} as never;
    const controller = new AbortController();
    mocks.migrate.mockImplementationOnce(() => {
      controller.abort();
    });

    await handler(
      {} as never,
      response,
      JSON.stringify({ session_id: "cancelled", cwd: "/ok" }),
      { signal: controller.signal },
    );

    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "request cancelled" });
    expect(mocks.send.mock.calls.some(([, status, body]) => status === 200 && body?.recorded === true)).toBe(false);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("returns a sanitized 503 for typed PostgreSQL transaction failures", async () => {
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
    mocks.run.mockRejectedValueOnce(new StorageOperationError(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      "project",
      "coordination",
      "recordSessionIngest",
    ));
    const response = {} as never;

    await createSessionCompleteHandler(postgresqlConfig)({} as never, response, JSON.stringify({ session_id: "s", cwd: "/ok" }));

    expect(mocks.send).toHaveBeenLastCalledWith(response, 503, expect.objectContaining({
      code: "STORAGE_OPERATION_FAILED",
      backend: "postgresql",
    }));
  });
});
