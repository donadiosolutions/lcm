import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { makeMockStorageFactory } from "./mock-storage-factory.js";

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
    mocks.validate.mockImplementation((cwd: string) => cwd);
    mocks.scrub.mockImplementation((text: string) => text);
    mocks.createFactory.mockImplementation(() => makeMockStorageFactory({
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
});
