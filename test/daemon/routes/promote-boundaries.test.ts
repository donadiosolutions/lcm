import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { StorageOperationError } from "../../../src/storage/errors.js";
import { makeMockStorageFactory } from "./mock-storage-factory.js";
import {
  createInvocationCoordinator,
  InvocationCoordinatorError,
  type InvocationCoordinator,
} from "../../../src/daemon/invocation-coordinator.js";
import type { RouteExecutionContext } from "../../../src/daemon/server.js";
import { createAbortError } from "../../../src/daemon/cancellation.js";

const mocks = vi.hoisted(() => ({
  exists: vi.fn(() => true),
  read: vi.fn(() => "{}"),
  write: vi.fn(),
  mkdir: vi.fn(),
  getConnection: vi.fn(() => ({})),
  closeConnection: vi.fn(),
  migrate: vi.fn(),
  conversations: vi.fn(async () => [] as unknown[]),
  summaries: vi.fn(async () => [] as unknown[]),
  prefixes: vi.fn(() => [] as string[]),
  shouldPromote: vi.fn(() => ({ promote: false, tags: [], confidence: 0 })),
  dedup: vi.fn(async () => undefined),
  validate: vi.fn((cwd: string) => cwd),
  send: vi.fn(),
  scrub: vi.fn((text: string) => text),
  openProject: vi.fn(),
  projectClose: vi.fn(async () => undefined),
  factoryClose: vi.fn(async () => undefined),
  transaction: vi.fn(),
  projectExists: vi.fn(async () => true),
  createFactory: vi.fn(),
  dedupObserver: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  existsSync: mocks.exists,
  readFileSync: mocks.read,
  writeFileSync: mocks.write,
  mkdirSync: mocks.mkdir,
}));
vi.mock("../../../src/daemon/project.js", () => ({
  projectPaths: (cwd: string) => ({ id: "pid", dbPath: `${cwd}/lcm.db`, metaPath: `${cwd}/meta.json`, canonical: cwd }),
  projectIdentity: (cwd: string) => ({ id: "pid", canonical: cwd }),
}));
vi.mock("../../../src/daemon/server.js", () => ({ sendJson: mocks.send }));
vi.mock("../../../src/db/connection.js", () => ({ getLcmConnection: mocks.getConnection, closeLcmConnection: mocks.closeConnection }));
vi.mock("../../../src/db/migration.js", () => ({ runLcmMigrations: mocks.migrate }));
vi.mock("../../../src/store/conversation-store.js", () => ({ ConversationStore: class { listConversations = mocks.conversations; } }));
vi.mock("../../../src/store/summary-store.js", () => ({ SummaryStore: class { getSummariesByConversation = mocks.summaries; } }));
vi.mock("../../../src/db/promoted.js", () => ({ PromotedStore: class { listContentPrefixes = mocks.prefixes; } }));
vi.mock("../../../src/promotion/detector.js", () => ({ shouldPromote: mocks.shouldPromote }));
vi.mock("../../../src/promotion/dedup.js", () => ({ deduplicateAndInsert: mocks.dedup }));
vi.mock("../../../src/daemon/validate-cwd.js", () => ({ validateCwd: mocks.validate }));
vi.mock("../../../src/scrub.js", () => ({
  ScrubEngine: { forProject: async () => ({ scrub: mocks.scrub }) },
}));
vi.mock("../../../src/storage/index.js", () => ({ createStorageBackendFactory: mocks.createFactory }));

import { createPromoteHandler } from "../../../src/daemon/routes/promote.js";

const config = loadDaemonConfig("/tmp/promote-boundaries");
const response = {} as never;

describe("promote persistence boundaries", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.exists.mockReturnValue(true);
    mocks.projectExists.mockResolvedValue(true);
    mocks.read.mockReturnValue("{}");
    mocks.getConnection.mockReturnValue({});
    mocks.conversations.mockResolvedValue([]);
    mocks.summaries.mockResolvedValue([]);
    mocks.prefixes.mockReturnValue([]);
    mocks.shouldPromote.mockReturnValue({ promote: false, tags: [], confidence: 0 });
    mocks.dedup.mockResolvedValue(undefined);
    mocks.dedupObserver.mockReset();
    mocks.validate.mockImplementation((cwd: string) => cwd);
    mocks.scrub.mockImplementation((text: string) => text);
    mocks.createFactory.mockImplementation(async () => makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }));
    mocks.openProject.mockResolvedValue({
      conversations: { listConversations: mocks.conversations },
      summaries: { getSummariesByConversation: mocks.summaries },
      promotedMemory: { listContentPrefixes: mocks.prefixes },
      lexicalSearch: {},
      transaction: mocks.transaction,
      close: mocks.projectClose,
    });
  });

  it("compares stored prefixes with the same scrubbed content used for insertion", async () => {
    mocks.conversations.mockResolvedValueOnce([{ conversationId: 1, sessionId: "s" }]);
    mocks.summaries.mockResolvedValueOnce([
      { content: "token=secret", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
    ]);
    mocks.scrub.mockReturnValueOnce("token=[REDACTED]");
    mocks.prefixes.mockReturnValueOnce(["token=[REDACTED]"]);

    const injected = makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    });
    await createPromoteHandler(config, injected)({} as never, response, JSON.stringify({ cwd: "/ok" }));

    expect(mocks.shouldPromote).not.toHaveBeenCalled();
    expect(mocks.dedup).not.toHaveBeenCalled();
    expect(mocks.scrub).toHaveBeenCalledOnce();
    expect(mocks.factoryClose).not.toHaveBeenCalled();
  });

  it("validates cwd and missing databases", async () => {
    const handler = createPromoteHandler(config);
    await handler({} as never, response, "");
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "cwd is required" });
    mocks.validate.mockImplementationOnce(() => { throw new Error("bad cwd"); });
    await handler({} as never, response, JSON.stringify({ cwd: "/bad" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "bad cwd" });
    mocks.validate.mockImplementationOnce(() => { throw "failure"; });
    await handler({} as never, response, JSON.stringify({ cwd: "/bad" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, { error: "invalid cwd" });
    mocks.projectExists.mockResolvedValueOnce(false);
    await handler({} as never, response, JSON.stringify({ cwd: "/missing" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { processed: 0, promoted: 0 });
  });

  it("skips duplicates and low-signal summaries and counts dry runs", async () => {
    mocks.conversations.mockResolvedValueOnce([{ conversationId: 1, sessionId: "s" }]);
    mocks.summaries.mockResolvedValueOnce([
      { content: "duplicate", depth: 0, tokenCount: 1, sourceMessageTokenCount: 2 },
      { content: "low signal", depth: 0, tokenCount: 1, sourceMessageTokenCount: 2 },
      { content: "promote", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
    ]);
    mocks.prefixes.mockReturnValueOnce(["duplicate"]);
    mocks.shouldPromote
      .mockReturnValueOnce({ promote: false, tags: [], confidence: 0 })
      .mockReturnValueOnce({ promote: true, tags: ["depth"], confidence: 0.25 });
    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/ok", dry_run: true }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { processed: 2, promoted: 1, conversations: 1 });
    expect(mocks.dedup).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("inserts promoted summaries, ignores individual failures, and updates metadata", async () => {
    mocks.conversations.mockResolvedValueOnce([{ conversationId: 1, sessionId: "s" }]);
    mocks.summaries.mockResolvedValueOnce([
      { content: "first", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
      { content: "second", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
    ]);
    mocks.shouldPromote.mockReturnValue({ promote: true, tags: ["depth"], confidence: 0.25 });
    mocks.dedup.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("duplicate failed"));
    mocks.read.mockReturnValueOnce(JSON.stringify({ existing: true }));
    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { processed: 2, promoted: 1, conversations: 1 });
    expect(mocks.write).toHaveBeenCalledOnce();

    mocks.exists.mockReturnValueOnce(true);
    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.write).toHaveBeenCalledTimes(2);
    mocks.read.mockImplementationOnce(() => { throw new Error("meta failed"); });
    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, { processed: 0, promoted: 0, conversations: 0 });
  });

  it("normalizes typed and untyped failures and closes acquired connections", async () => {
    const handler = createPromoteHandler(config);
    mocks.openProject.mockRejectedValueOnce(new Error("migration failed"));
    await handler({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "migration failed" });
    mocks.openProject.mockRejectedValueOnce("failure");
    await handler({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.send).toHaveBeenLastCalledWith(response, 500, { error: "promote failed" });
    expect(mocks.projectClose).not.toHaveBeenCalled();
    expect(mocks.factoryClose).toHaveBeenCalledTimes(2);
  });

  it("creates metadata when the file is absent", async () => {
    mocks.read.mockImplementationOnce(() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
    await createPromoteHandler(config)({} as never, response, JSON.stringify({ cwd: "/ok" }));
    expect(mocks.write).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 200, {
      processed: 0,
      promoted: 0,
      conversations: 0,
    });
  });

  it("does not swallow typed PostgreSQL repository failures from deduplication", async () => {
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
    mocks.conversations.mockResolvedValueOnce([{ conversationId: 1, sessionId: "s" }]);
    mocks.summaries.mockResolvedValueOnce([
      { content: "promote", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
    ]);
    mocks.shouldPromote.mockReturnValueOnce({ promote: true, tags: [], confidence: 0.5 });
    mocks.dedup.mockRejectedValueOnce(new StorageOperationError(
      "STORAGE_OPERATION_FAILED",
      "postgresql",
      "project",
      "repository",
      "promote",
    ));

    await createPromoteHandler(postgresqlConfig)({} as never, response, JSON.stringify({ cwd: "/pg" }));

    expect(mocks.send).toHaveBeenLastCalledWith(response, 503, expect.objectContaining({
      code: "STORAGE_OPERATION_FAILED",
      backend: "postgresql",
    }));
  });

  it("rejects unknown invocation identifiers before opening project storage", async () => {
    const coordinator = createInvocationCoordinator({
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    const handler = createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }));

    await handler(
      {} as never,
      response,
      JSON.stringify({ cwd: "/unknown", invocation_id: "22222222-2222-4222-8222-222222222222" }),
      { invocationCoordinator: coordinator } satisfies RouteExecutionContext,
    );

    expect(mocks.openProject).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 404, {
      error: expect.stringMatching(/unknown|invocation/i),
    });
    await coordinator.shutdown();
  });

  it("fails closed when a supplied invocation has no coordinator", async () => {
    const handler = createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }));
    await handler(
      {} as never,
      response,
      JSON.stringify({ cwd: "/missing-coordinator", invocation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    );
    expect(mocks.openProject).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 503, {
      error: "invocation control unavailable",
    });
  });

  it("returns bounded cancellation when coordinator admission is already aborted", async () => {
    const base = createInvocationCoordinator({
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    const coordinator = {
      ...base,
      heartbeat: () => { throw createAbortError(); },
    } as unknown as InvocationCoordinator;
    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }))(
      {} as never,
      response,
      JSON.stringify({ cwd: "/admission-abort", invocation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
      { invocationCoordinator: coordinator } satisfies RouteExecutionContext,
    );
    expect(mocks.openProject).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 499, {
      status: "cancelled",
      error: "promote cancelled",
    });
    await base.shutdown();
  });

  it("absorbs a cancellation response when the transport is already closed", async () => {
    const base = createInvocationCoordinator({
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    const coordinator = {
      ...base,
      heartbeat: () => { throw createAbortError(); },
    } as unknown as InvocationCoordinator;
    const closedResponse = { headersSent: true } as never;
    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }))(
      {} as never,
      closedResponse,
      JSON.stringify({ cwd: "/closed", invocation_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }),
      { invocationCoordinator: coordinator } satisfies RouteExecutionContext,
    );
    expect(mocks.send).not.toHaveBeenCalled();
    await base.shutdown();
  });

  it("uses a bounded fallback for non-Error coordinator admission failures", async () => {
    const base = createInvocationCoordinator({
      daemonInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    const coordinator = {
      ...base,
      heartbeat: () => { throw "admission failed"; },
    } as unknown as InvocationCoordinator;
    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }))(
      {} as never,
      response,
      JSON.stringify({ cwd: "/primitive-admission", invocation_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }),
      { invocationCoordinator: coordinator } satisfies RouteExecutionContext,
    );
    expect(mocks.send).toHaveBeenLastCalledWith(response, 409, {
      error: "invocation admission failed",
    });
    await base.shutdown();
  });

  it("cancels a supplied invocation whose request signal was already aborted", async () => {
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const invocationId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    const requestController = new AbortController();
    requestController.abort();

    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }))(
      {} as never,
      response,
      JSON.stringify({ cwd: "/pre-aborted", invocation_id: invocationId }),
      {
        signal: requestController.signal,
        invocationCoordinator: coordinator,
      } satisfies RouteExecutionContext,
    );
    expect(mocks.openProject).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 499, {
      status: "cancelled",
      error: "promote cancelled",
    });
    expect(coordinator.snapshot(invocationId)).toMatchObject({ state: "cancelling", activeCount: 0 });
    await coordinator.shutdown();
  });

  it("keeps cancellation bounded when targeted cancel control rejects", async () => {
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const invocationId = "12121212-1212-4212-8212-121212121212";
    const base = createInvocationCoordinator({ daemonInstanceId });
    base.start({ invocationId, command: "compact", daemonInstanceId });
    const requestController = new AbortController();
    const coordinator = {
      ...base,
      cancel: async () => { throw new Error("control unavailable"); },
    } as unknown as InvocationCoordinator;
    mocks.conversations.mockResolvedValueOnce([{ conversationId: 1, sessionId: "s" }]);
    mocks.summaries.mockResolvedValueOnce([
      { content: "first", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
    ]);
    mocks.shouldPromote.mockReturnValue({ promote: true, tags: [], confidence: 0.25 });
    mocks.dedup.mockImplementation(async () => { requestController.abort(); });

    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }))(
      {} as never,
      response,
      JSON.stringify({ cwd: "/cancel-reject", invocation_id: invocationId }),
      {
        signal: requestController.signal,
        invocationCoordinator: coordinator,
      } satisfies RouteExecutionContext,
    );
    expect(mocks.send).toHaveBeenLastCalledWith(response, 499, {
      status: "cancelled",
      error: "promote cancelled",
    });
    await base.shutdown();
  });

  it("detaches request and composed-signal listeners after invocation settlement", async () => {
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const invocationId = "13131313-1313-4313-8313-131313131313";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    const requestController = new AbortController();
    const addListener = vi.spyOn(requestController.signal, "addEventListener");
    const removeListener = vi.spyOn(requestController.signal, "removeEventListener");

    try {
      await createPromoteHandler(config, makeMockStorageFactory({
        projectExists: mocks.projectExists,
        openProject: mocks.openProject,
        close: mocks.factoryClose,
      }))(
        {} as never,
        response,
        JSON.stringify({ cwd: "/listener-cleanup", invocation_id: invocationId }),
        {
          signal: requestController.signal,
          invocationCoordinator: coordinator,
        } satisfies RouteExecutionContext,
      );
      const added = addListener.mock.calls
        .filter(([type]) => type === "abort")
        .map(([, listener]) => listener);
      const removed = removeListener.mock.calls
        .filter(([type]) => type === "abort")
        .map(([, listener]) => listener);
      expect(added.length).toBeGreaterThan(0);
      expect(removed).toEqual(expect.arrayContaining(added));
      expect(coordinator.snapshot(invocationId)).toMatchObject({
        state: "active",
        activeCount: 0,
        workCount: 0,
        commitCount: 0,
      });
    } finally {
      addListener.mockRestore();
      removeListener.mockRestore();
      await coordinator.shutdown();
    }
  });

  it("rejects malformed and late invocation identifiers before opening project storage", async () => {
    const handler = createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }));

    await handler(
      {} as never,
      response,
      JSON.stringify({ cwd: "/malformed", invocation_id: "not-a-uuid" }),
    );
    expect(mocks.openProject).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 400, {
      error: "invocation_id must be a canonical UUID",
    });

    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const invocationId = "55555555-5555-4555-8555-555555555555";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    await coordinator.finish({ invocationId, command: "compact", daemonInstanceId });

    await handler(
      {} as never,
      response,
      JSON.stringify({ cwd: "/late", invocation_id: invocationId }),
      { invocationCoordinator: coordinator } satisfies RouteExecutionContext,
    );
    expect(mocks.openProject).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 409, {
      error: expect.stringMatching(/terminal|cancel/i),
    });
    await coordinator.shutdown();
  });

  it("cancels the targeted invocation during promotion and releases active work", async () => {
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const invocationId = "33333333-3333-4333-8333-333333333333";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    const requestController = new AbortController();
    mocks.conversations.mockResolvedValueOnce([{ conversationId: 1, sessionId: "s" }]);
    mocks.summaries.mockResolvedValueOnce([
      { content: "first", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
      { content: "second", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
    ]);
    mocks.shouldPromote.mockReturnValue({ promote: true, tags: ["depth"], confidence: 0.25 });
    mocks.dedupObserver.mockImplementation(() => { requestController.abort(); });
    mocks.dedup.mockImplementation(async () => {
      await mocks.dedupObserver?.();
    });

    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }))(
      {} as never,
      response,
      JSON.stringify({ cwd: "/cancel", invocation_id: invocationId }),
      {
        signal: requestController.signal,
        invocationCoordinator: coordinator,
      } satisfies RouteExecutionContext,
    );

    expect(mocks.dedup).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 499, {
      status: "cancelled",
      error: "promote cancelled",
    });
    expect(coordinator.snapshot(invocationId)).toMatchObject({
      state: "cancelling",
      activeCount: 0,
      workCount: 0,
      commitCount: 0,
    });
    await coordinator.shutdown();
  });

  it("lets a pre-cancel commit finish one write but starts no later summary", async () => {
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const invocationId = "44444444-4444-4444-8444-444444444444";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    const requestController = new AbortController();
    let abortOnCommit = true;
    const wrappedCoordinator = {
      ...coordinator,
      acquireCommit: (target: Parameters<typeof coordinator.acquireCommit>[0]) => {
        const permit = coordinator.acquireCommit(target);
        if (abortOnCommit) {
          abortOnCommit = false;
          requestController.abort();
        }
        return permit;
      },
    } as unknown as InvocationCoordinator;
    mocks.conversations.mockResolvedValueOnce([{ conversationId: 1, sessionId: "s" }]);
    mocks.summaries.mockResolvedValueOnce([
      { content: "first", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
      { content: "second", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
    ]);
    mocks.shouldPromote.mockReturnValue({ promote: true, tags: ["depth"], confidence: 0.25 });

    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }))(
      {} as never,
      response,
      JSON.stringify({ cwd: "/pre-cancel", invocation_id: invocationId }),
      {
        signal: requestController.signal,
        invocationCoordinator: wrappedCoordinator,
      } satisfies RouteExecutionContext,
    );

    expect(mocks.dedup).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 499, {
      status: "cancelled",
      error: "promote cancelled",
    });
    expect(coordinator.snapshot(invocationId)).toMatchObject({ state: "cancelling", activeCount: 0 });
    await coordinator.shutdown();
  });

  it("lets a pre-cancel metadata permit finish its atomic write and skips later work", async () => {
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const invocationId = "66666666-6666-4666-8666-666666666666";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    const requestController = new AbortController();
    let abortOnCommit = true;
    const wrappedCoordinator = {
      ...coordinator,
      acquireCommit: (target: Parameters<typeof coordinator.acquireCommit>[0]) => {
        const permit = coordinator.acquireCommit(target);
        if (abortOnCommit) {
          abortOnCommit = false;
          requestController.abort();
        }
        return permit;
      },
    } as unknown as InvocationCoordinator;

    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }))(
      {} as never,
      response,
      JSON.stringify({ cwd: "/metadata-latch", invocation_id: invocationId }),
      {
        signal: requestController.signal,
        invocationCoordinator: wrappedCoordinator,
      } satisfies RouteExecutionContext,
    );

    expect(mocks.write).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenLastCalledWith(response, 499, {
      status: "cancelled",
      error: "promote cancelled",
    });
    expect(coordinator.snapshot(invocationId)).toMatchObject({ state: "cancelling", activeCount: 0 });
    await coordinator.shutdown();
  });

  it("runs metadata under the supplied publication admission", async () => {
    const withPublicationAdmission = vi.fn(async <T>(operation: (token: object) => Promise<T> | T): Promise<T> =>
      await operation({}),
    );
    mocks.conversations.mockResolvedValueOnce([]);
    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }))(
      {} as never,
      response,
      JSON.stringify({ cwd: "/publication" }),
      { withPublicationAdmission } satisfies RouteExecutionContext,
    );
    expect(withPublicationAdmission).toHaveBeenCalledTimes(2);
    expect(mocks.write).toHaveBeenCalledOnce();
  });

  it("returns the coordinator cancellation response when a commit permit is refused", async () => {
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const invocationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const base = createInvocationCoordinator({ daemonInstanceId });
    base.start({ invocationId, command: "compact", daemonInstanceId });
    const coordinator = {
      ...base,
      acquireCommit: () => {
        throw new InvocationCoordinatorError("cancelled", "invocation is cancelling", 409);
      },
    } as unknown as InvocationCoordinator;

    await createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }))(
      {} as never,
      response,
      JSON.stringify({ cwd: "/commit-refused", invocation_id: invocationId }),
      { invocationCoordinator: coordinator } satisfies RouteExecutionContext,
    );
    expect(mocks.send).toHaveBeenLastCalledWith(response, 409, {
      error: "invocation admission failed",
    });
    await base.shutdown();
  });

  it("isolates cancellation to the matching invocation while another promotion completes", async () => {
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const firstInvocationId = "77777777-7777-4777-8777-777777777777";
    const secondInvocationId = "88888888-8888-4888-8888-888888888888";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId: firstInvocationId, command: "compact", daemonInstanceId });
    coordinator.start({ invocationId: secondInvocationId, command: "compact", daemonInstanceId });
    const firstRequest = new AbortController();
    const secondRequest = new AbortController();
    mocks.openProject.mockImplementation(async (identity: { canonical: string }) => ({
      conversations: { listConversations: async () => [{ conversationId: identity.canonical, sessionId: identity.canonical }] },
      summaries: {
        getSummariesByConversation: async () => [
          { content: identity.canonical, depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
        ],
      },
      promotedMemory: { listContentPrefixes: async () => [] },
      lexicalSearch: {},
      transaction: mocks.transaction,
      close: mocks.projectClose,
    }) as never);
    mocks.shouldPromote.mockReturnValue({ promote: true, tags: ["depth"], confidence: 0.25 });
    mocks.dedup.mockImplementation(async (params: { content: string }) => {
      if (params.content === "/first") firstRequest.abort();
    });
    const factory = makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    });
    const handler = createPromoteHandler(config, factory);

    const first = handler(
      {} as never,
      response,
      JSON.stringify({ cwd: "/first", invocation_id: firstInvocationId }),
      { signal: firstRequest.signal, invocationCoordinator: coordinator } satisfies RouteExecutionContext,
    );
    const second = handler(
      {} as never,
      response,
      JSON.stringify({ cwd: "/second", invocation_id: secondInvocationId }),
      { signal: secondRequest.signal, invocationCoordinator: coordinator } satisfies RouteExecutionContext,
    );
    await Promise.all([first, second]);

    expect(mocks.dedup).toHaveBeenCalledTimes(2);
    expect(coordinator.snapshot(firstInvocationId)).toMatchObject({ state: "cancelling", activeCount: 0 });
    expect(coordinator.snapshot(secondInvocationId)).toMatchObject({ state: "active", activeCount: 0 });
    expect(mocks.send).toHaveBeenCalledWith(response, 499, {
      status: "cancelled",
      error: "promote cancelled",
    });
    expect(mocks.send).toHaveBeenCalledWith(response, 200, {
      processed: 1,
      promoted: 1,
      conversations: 1,
    });
    await coordinator.shutdown();
  });

  it("waits for an invocation-owned promotion to settle during coordinator shutdown", async () => {
    const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
    const invocationId = "99999999-9999-4999-8999-999999999999";
    const coordinator = createInvocationCoordinator({ daemonInstanceId });
    coordinator.start({ invocationId, command: "compact", daemonInstanceId });
    mocks.conversations.mockResolvedValueOnce([{ conversationId: 1, sessionId: "s" }]);
    mocks.summaries.mockResolvedValueOnce([
      { content: "held", depth: 1, tokenCount: 1, sourceMessageTokenCount: 3 },
    ]);
    mocks.shouldPromote.mockReturnValue({ promote: true, tags: [], confidence: 0.25 });
    let releaseDedup!: () => void;
    const dedupGate = new Promise<void>(resolve => { releaseDedup = resolve; });
    mocks.dedup.mockImplementation(async () => { await dedupGate; });
    const handler = createPromoteHandler(config, makeMockStorageFactory({
      projectExists: mocks.projectExists,
      openProject: mocks.openProject,
      close: mocks.factoryClose,
    }));
    const pending = handler(
      {} as never,
      response,
      JSON.stringify({ cwd: "/shutdown", invocation_id: invocationId }),
      { invocationCoordinator: coordinator } satisfies RouteExecutionContext,
    );
    await vi.waitFor(() => expect(mocks.dedup).toHaveBeenCalledOnce());
    const stopping = coordinator.shutdown();
    let settled = false;
    void stopping.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseDedup();
    await pending;
    await expect(stopping).resolves.toBeUndefined();
    expect(coordinator.snapshot(invocationId)).toMatchObject({ state: "cancelled", activeCount: 0 });
  });
});
